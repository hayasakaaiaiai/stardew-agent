"""Download rendered wiki pages via the MediaWiki parse API.

usage: python3 -I fetch_wiki.py <out_dir>
Writes <out_dir>/{en,zh}/<English title>.json and <out_dir>/rights.json.
"""
import json
import os
import subprocess
import sys
import time
import urllib.parse

UA = "stardew-agent-reference/0.1 (personal research; single run)"
API = {
    "en": "https://stardewvalleywiki.com/mediawiki/api.php",
    "zh": "https://zh.stardewvalleywiki.com/mediawiki/api.php",
}


def get(lang, params):
    # urllib gets 403 from the wiki's CDN; curl does not.
    url = API[lang] + "?" + urllib.parse.urlencode({**params, "format": "json", "formatversion": "2"})
    for attempt in range(3):
        try:
            out = subprocess.run(["curl", "-sS", "-f", "-m", "30", "-A", UA, url], capture_output=True, check=True)
            return json.loads(out.stdout)
        except Exception as err:  # retry transient failures
            print(f"  retry {attempt + 1}: {err}", file=sys.stderr)
            time.sleep(3 * (attempt + 1))
    raise RuntimeError(f"failed: {url}")


PAGES = [
    "Abigail", "Alex", "Elliott", "Emily", "Haley", "Harvey", "Leah", "Maru", "Penny", "Sam", "Sebastian", "Shane",
    "Caroline", "Clint", "Demetrius", "Dwarf", "Evelyn", "George", "Gus", "Jas", "Jodi", "Kent", "Krobus", "Leo",
    "Lewis", "Linus", "Marnie", "Pam", "Pierre", "Robin", "Sandy", "Vincent", "Willy", "Wizard",
    "Friendship", "Marriage", "Festivals",
]


def main():
    out = sys.argv[1]
    links = get("en", {"action": "query", "titles": "|".join(PAGES), "prop": "langlinks", "lllang": "zh", "lllimit": "500"})
    titles = {p["title"]: p["langlinks"][0]["title"] for p in links["query"]["pages"]}
    for lang in ("en", "zh"):
        os.makedirs(os.path.join(out, lang), exist_ok=True)
    rights = {lang: get(lang, {"action": "query", "meta": "siteinfo", "siprop": "rightsinfo|general"})["query"] for lang in API}
    json.dump(rights, open(os.path.join(out, "rights.json"), "w"), ensure_ascii=False, indent=2)
    for en, zh in sorted(titles.items()):
        for lang, title in (("en", en), ("zh", zh)):
            path = os.path.join(out, lang, f"{en}.json")
            if os.path.exists(path):
                continue
            data = get(lang, {
                "action": "parse", "page": title, "prop": "text|revid|displaytitle",
                "redirects": "1", "disableeditsection": "1", "disablelimitreport": "1",
            })
            data["_source_title"] = title
            json.dump(data, open(path, "w"), ensure_ascii=False)
            print(f"{lang} {en} ({title}) ok")
            time.sleep(0.8)


main()
