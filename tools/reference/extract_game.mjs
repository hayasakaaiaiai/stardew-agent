// Export Stardew Valley's zh-CN text dictionaries into per-NPC Markdown for writing role cards.
// usage: node extract_game.mjs <xnb-lib-dir> <game Content dir> <out dir>
// Reads game files only; writes <out>/<Npc>.md and <out>/raw/<path>.json.
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

const [, , lib, content, out] = process.argv
const XNB = await import(`${lib}/xnb.module.mjs`)

const NPCS = ['Abigail', 'Alex', 'Elliott', 'Emily', 'Haley', 'Harvey', 'Leah', 'Maru', 'Penny', 'Sam', 'Sebastian', 'Shane',
  'Caroline', 'Clint', 'Demetrius', 'Dwarf', 'Evelyn', 'George', 'Gus', 'Jas', 'Jodi', 'Kent', 'Krobus', 'Leo', 'Lewis',
  'Linus', 'Marnie', 'Pam', 'Pierre', 'Robin', 'Sandy', 'Vincent', 'Willy', 'Wizard']

const quiet = console.log
console.log = (...a) => { if (!/XNB file|decompressed|Successfuly/.test(String(a[0]))) quiet(...a) }

async function load(rel) {
  try {
    const buf = await readFile(join(content, rel))
    const { content: blob } = await XNB.unpackToContent(buf)
    const data = JSON.parse(await blob.text())
    const target = join(out, 'raw', rel.replace(/\.xnb$/, '.json'))
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, JSON.stringify(data, null, 2))
    return data
  } catch (err) {
    if (err.code !== 'ENOENT') console.error(`skip ${rel}: ${err.message}`)
    return undefined
  }
}

// Make engine markup readable: breaks, player name, portrait codes at segment ends.
const PORTRAIT = { h: '开心', s: '难过', u: '特殊', l: '害羞', a: '生气', k: '表情k', '0': '' }
function fmt(line) {
  return String(line)
    .replace(/#\$b#/g, ' ／ ')
    .replace(/#\$e#/g, ' ／／ ')
    .replace(/@/g, '〈玩家〉')
    .replace(/\$([hsulak]|\d+)(?=\s*(?:#|$|\^|／))/g, (_, code) => {
      const name = PORTRAIT[code] ?? `表情${code}`
      return name ? `〔${name}〕` : ''
    })
    .replace(/\s+/g, ' ')
    .trim()
}

const bullet = (key, value) => `- \`${key}\`：${fmt(value)}`

function section(title, lines, note) {
  if (!lines.length) return ''
  return `## ${title}\n\n${note ? `${note}\n\n` : ''}${lines.join('\n')}\n`
}

const names = (await load('Strings/NPCNames.zh-CN.xnb')) ?? {}
const zhName = (npc) => names[npc] ?? npc

const rainy = (await load('Characters/Dialogue/rainy.zh-CN.xnb')) ?? {}
const engagement = (await load('Data/EngagementDialogue.zh-CN.xnb')) ?? {}
const gifts = (await load('Data/NPCGiftTastes.zh-CN.xnb')) ?? {}
const mail = (await load('Data/mail.zh-CN.xnb')) ?? {}

const festivals = []
for (const file of (await readdir(join(content, 'Data/Festivals'))).filter((f) => f.endsWith('.zh-CN.xnb')).sort()) {
  const data = await load(`Data/Festivals/${file}`)
  if (data) festivals.push({ id: file.replace('.zh-CN.xnb', ''), data })
}

const events = []
for (const file of (await readdir(join(content, 'Data/Events'))).filter((f) => f.endsWith('.zh-CN.xnb')).sort()) {
  const data = await load(`Data/Events/${file}`)
  if (!data) continue
  for (const [key, script] of Object.entries(data)) {
    const lines = [...String(script).matchAll(/(?:speak|textAboveHead) (\w+) "([^"]*)"/g)].map((m) => [m[1], m[2]])
    if (lines.length) events.push({ location: file.replace('.zh-CN.xnb', ''), key, lines })
  }
}

await mkdir(out, { recursive: true })
for (const npc of NPCS) {
  const zh = zhName(npc)
  const parts = [`# ${zh}（${npc}）— 游戏原文\n\n> 从本机 Stardew Valley 1.6.15 的 zh-CN 文本导出，只用于写角色卡时参考，不要分发。标记说明见 \`reference/README.md\`。\n`]

  const daily = (await load(`Characters/Dialogue/${npc}.zh-CN.xnb`)) ?? {}
  if (npc === 'Leo') Object.assign(daily, Object.fromEntries(Object.entries((await load('Characters/Dialogue/LeoMainland.zh-CN.xnb')) ?? {}).map(([k, v]) => [`Mainland:${k}`, v])))
  parts.push(section('日常台词', Object.entries(daily).map(([k, v]) => bullet(k, v))))

  if (rainy[npc]) parts.push(section('雨天台词', [bullet(npc, rainy[npc])]))

  const marriage = (await load(`Characters/Dialogue/MarriageDialogue${npc}.zh-CN.xnb`)) ?? {}
  parts.push(section('婚后台词', Object.entries(marriage).map(([k, v]) => bullet(k, v))))

  parts.push(section('订婚台词', Object.entries(engagement).filter(([k]) => k.startsWith(npc)).map(([k, v]) => bullet(k, v))))

  if (gifts[npc]) {
    const f = String(gifts[npc]).split('/')
    const labels = ['最爱', '喜欢', '不喜欢', '讨厌', '一般']
    parts.push(section('收礼反应', labels.map((label, i) => `- ${label}：${fmt(f[i * 2] ?? '')}`),
      '具体喜欢哪些物品见 wiki 页面的“送礼”部分。'))
  }

  const fest = []
  for (const { id, data } of festivals) {
    const title = data.name ?? id
    for (const [k, v] of Object.entries(data)) {
      if (k === npc || k.startsWith(`${npc}_`)) fest.push(`- ${title} \`${k}\`：${fmt(v)}`)
    }
    for (const [k, v] of Object.entries(data)) {
      for (const m of String(v).matchAll(new RegExp(`(?:speak|textAboveHead) ${npc} "([^"]*)"`, 'g'))) {
        fest.push(`- ${title}（脚本 \`${k}\`）：${fmt(m[1])}`)
      }
    }
  }
  parts.push(section('节日台词', fest))

  const sched = (await load(`Strings/schedules/${npc}.zh-CN.xnb`)) ?? {}
  parts.push(section('日程途中的台词', Object.entries(sched).map(([k, v]) => bullet(k, v))))

  const ev = events.filter((e) => e.lines.some(([who]) => who === npc))
  parts.push(section('事件台词', ev.map((e) => {
    const [id, ...conds] = e.key.split('/')
    const head = `### ${e.location} · 事件 ${id}${conds.length ? `\n\n条件：\`${conds.join(' / ')}\`` : ''}`
    return `${head}\n\n${e.lines.map(([who, text]) => `- ${zhName(who)}：${fmt(text)}`).join('\n')}\n`
  }), '包括心事件。条件里的 `f <NPC> <点数>` 表示需要的好感点数（250 点 = 1 心）。'))

  // Letters are signed "——罗宾" (sometimes just "^罗宾") right before item/title markup.
  const signature = new RegExp(`(?:[-—–]+\\s*|\\^\\s*)${zh}\\s*(?:%|\\[|$|\\^)`)
  const letters = Object.entries(mail).filter(([, v]) => signature.test(String(v)))
  parts.push(section('信件', letters.map(([k, v]) => bullet(k, String(v).replace(/\^/g, ' ')))))

  await writeFile(join(out, `${npc}.md`), parts.filter(Boolean).join('\n'))
  quiet(`${npc} (${zh}) daily=${Object.keys(daily).length} marriage=${Object.keys(marriage).length} fest=${fest.length} events=${ev.length} letters=${letters.length}`)
}
