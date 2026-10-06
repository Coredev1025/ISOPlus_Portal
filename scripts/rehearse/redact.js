// mongosh script: turn a restored COPY of production into a redacted copy that is safe to share with
// the team, while keeping the data's shape so migrations, backfills, statements and exports behave as
// they do on the real thing. Run by `npm run rehearse -- redact` (never on a real database).
//
//   mongosh --quiet <database> --file scripts/rehearse/redact.js
//
// Rules, in short (docs/roadmap/release-rehearsal.md, "The redacted copy"):
// * The same original value always becomes the same pseudonym, in every collection, so a participant
//   keeps one name across items, document rows and logs and statements still match by name.
// * Emails that the operations tests need to RECEIVE become the owner's plus-addresses on
//   isoconsultingservices.com.au: participant email -> masoud+participant@, billing email -> masoud+billing@,
//   business email -> masoud@. Every other email becomes a random user<hash>@example.com. (Copy and
//   reply-to addresses are set in the automation settings of the workspace under test:
//   masoud+cc@ and masoud+replyto@.)
// * Names, phone numbers, addresses, bank details, ABNs and ids, free-text notes, attachments and
//   document links are replaced. Tokens, sessions, hook secrets and password hashes are removed.
// * Prints one `LEAK:<original value>` line per replaced value so the harness can prove none survives.
// What this cannot guarantee: personal data written in a place no rule names. The leak check catches
// every replaced value that is left somewhere else; treat the result as sensitive until you have read it.

const OPS = {
  participant: 'masoud+participant@isoconsultingservices.com.au',
  billing: 'masoud+billing@isoconsultingservices.com.au',
  main: 'masoud@isoconsultingservices.com.au',
}
const FIRST = ['Alex', 'Blake', 'Casey', 'Drew', 'Ellis', 'Finn', 'Gale', 'Harper', 'Indy', 'Jules', 'Kai', 'Lee', 'Morgan', 'Nico', 'Oakley', 'Parker', 'Quinn', 'Riley', 'Sage', 'Taylor', 'Uma', 'Vale', 'Wren', 'Xan', 'Yael', 'Zion', 'Ari', 'Bay', 'Cleo', 'Dale', 'Eden', 'Fern', 'Glen', 'Hollis', 'Ivy', 'Jett', 'Kit', 'Lane', 'Mika', 'Noor', 'Orla', 'Pax', 'Remy', 'Sky', 'Tate', 'Uri', 'Vic', 'Wynn', 'Yuri', 'Zara']
const LAST = ['Aldridge', 'Brookes', 'Calloway', 'Dunmore', 'Ellery', 'Fairley', 'Garrick', 'Hartley', 'Ingram', 'Jessop', 'Kendall', 'Lockhart', 'Marlowe', 'Newell', 'Oakes', 'Prescott', 'Quigley', 'Radcliffe', 'Sterling', 'Thorne', 'Underhill', 'Vance', 'Whitlock', 'Yardley', 'Ashby', 'Bexley', 'Corbin', 'Dalton', 'Everly', 'Fenwick', 'Gatsby', 'Holloway', 'Iverson', 'Jarvis', 'Kirby', 'Lowell', 'Mercer', 'Norwood', 'Overton', 'Pembroke', 'Rutland', 'Sutton', 'Tavistock', 'Upton', 'Vickers', 'Wexford', 'Yelland', 'Ashworth', 'Barlow', 'Carver']

const H = (s) => { let h = 2166136261; for (const ch of String(s)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0 } return h }
const norm = (s) => String(s).trim().toLowerCase().replace(/\s+/g, ' ')
const fakeFirst = (s) => FIRST[H(norm(s)) % FIRST.length]
const fakeLast = (s) => LAST[(H(norm(s)) >>> 7) % LAST.length]
const fakeFull = (s) => `${fakeFirst(s)} ${fakeLast(s)}`
const fakePhone = (s) => `04${String(10000000 + (H(s) % 90000000))}`
const fakeEmail = (s) => `user${H(norm(s)).toString(36)}@example.com`
const fakeNumber = (s, digits) => Number(String(H(s)).padEnd(digits, '7').slice(0, digits))
const fakeStreet = (s) => `${1 + (H(s) % 99)} Example Street`
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g
// phone numbers and labelled registration numbers typed into free text and rich text
const PHONE_IN_TEXT = /(?:\+61|\b0)[\s-]?\d(?:[\s-]?\d){7,9}\b/g
const LABELLED_ID = /((?:registration (?:number|id)|provider (?:number|id)|abn|acn|ndis (?:number|no\.?|registration))\W{0,6})(\d(?:[\d ]{6,12})\d|\d-[A-Za-z0-9]{3,6}-\d{3,6})/gi
const ALLOWED_EMAIL = /(@example\.com|^masoud(\+(participant|billing|cc|replyto))?@isoconsultingservices\.com\.au)$/i

const leaks = new Set()
// Every original value that is replaced is recorded with a kind, so the proof can search the result for
// the ones that matter (email, phone, address, id, name with two or more words, business) and ignore
// fragments and free text.
const note = (value, kind) => {
  const text = typeof value === 'number' ? String(value) : value
  if (typeof text !== 'string' || text.trim().length < 5 || /^(.)\1+$/.test(text.trim())) return
  // an identifier always has a digit; a value without one is a generic label, not personal data
  if (kind === 'id' && !/\d/.test(text)) return
  if (kind === 'name' && !/\s/.test(text.trim())) return
  leaks.add(`${kind}\t${text.trim()}`)
}
const names = new Map() // normalised original full name -> pseudonym

// ---- item attribute rules (exact attribute names) --------------------------------------------------
const NAME_FULL = ['Participant Full Name', 'Full Name/Preferred Name', 'Type Your Full Name', 'Billing Contact', 'Contact Person', 'Plan Manager', 'Inspector Full Name', 'Participant/Representative Contribution (Full Name)', 'Representative Name', "Customer Representative's Full Name", "Project Manager's Full Name", "Reporter's Full Name", 'Ceasing Provider Contact Person', 'New Provider Contact Person', 'Account Manager', 'Account Name', 'Participant Name - Fund ID', "Client's Representative", 'If Loaned, Lender Name', 'Ceasing Provider Name', 'New Provider Name', 'Business/Individual']
const NAME_FIRST = ['First Name', "Contact Person's First Name"]
const NAME_LAST = ['Last Name', "Contact Person's Last Name"]
const NAME_MIDDLE = ['Middle Name']
const EMAIL_PARTICIPANT = ['Email']
const EMAIL_BILLING = ['Billing Email', 'Invoices Email', 'Recipient Email']
const EMAIL_OTHER = ['Plan Manager Email', 'Associated Provider Email for Notification', 'Ceasing Provider Email Address', 'New Provider Email Address', 'Inspector Email Address', 'Email Address', "Project Manager's Email Address", "Reporter's Email Address", "Customer Representative's Email Address"]
const PHONE = ['Primary Phone Number', 'Secondary Phone Number', 'Recipient Phone Number', 'Ceasing Provider Phone Number', 'New Provider Phone Number', 'Inspector Phone Number', 'Phone Number']
const ADDRESS = ['Address', 'Service Delivery Address', 'Billing Address', 'Recipient Address', 'Dwelling Address', 'New Provider Address', 'Ceasing Provider Address']
const IDS = { ABN: 11, 'NDIS Number': 9, 'NDIS Registration No. (if applicable)': 9, 'My Aged Care ID Number': 10, BSB: 6, 'Account Number': 8 }
const FREE_TEXT = ['Notes', 'Shift Notes', 'Care Notes', 'Description', 'Additional Notes', 'Review Notes', 'Warning', 'Warning Notes', 'Additional Notes and Instructions', 'Hobbies and Interests', 'Participant/Carer Feedback', 'Skin/Stoma Condition', 'Stoma/Skin Condition', 'Emergency Control Plan', 'Medication Name', 'Document Name', 'Diverse Group']
const CLEAR = ['Photo', 'Photos and Other Supporting Documents', 'Cover Image', 'Attachments', 'Attachments (receipts, ...)', 'Photos and Other Evidence', 'My Aged Care Support Plan/Notice of Decision', 'Photos & Other Attachments', 'Generated PDF Link']
const DOB = ['Date of Birth']
const IGNORED = new Set(['No Specific Location', 'Not Provided', '13 Sample Street Test', '13 Sample Street'])
const PII_KEYS = new Set([...NAME_FULL, ...NAME_FIRST, ...NAME_LAST, ...NAME_MIDDLE, ...EMAIL_PARTICIPANT, ...EMAIL_BILLING, ...EMAIL_OTHER, ...PHONE, ...ADDRESS, ...Object.keys(IDS), ...FREE_TEXT, ...CLEAR, ...DOB, 'Suburb'])

// replaces every string inside an object or array held under a personal-data key, and records it for the proof
const scrubLeaves = (key, value) => {
  if (Array.isArray(value)) return value.map((x) => scrubLeaves(key, x))
  if (value && typeof value === 'object') { const out = {}; for (const k of Object.keys(value)) out[k] = scrubLeaves(key, value[k]); return out }
  if (typeof value !== 'string' || !value.trim()) return value
  if (value.includes('@')) { note(value, 'email'); return ALLOWED_EMAIL.test(value) ? value : fakeEmail(value) }
  if (ADDRESS.includes(key)) { note(value, 'address'); return fakeStreet(value) }
  if (NAME_FULL.includes(key) || NAME_FIRST.includes(key) || NAME_LAST.includes(key)) { note(value, 'name'); names.set(norm(value), fakeFull(value)); return fakeFull(value) }
  note(value, 'free'); return 'Redacted free text.'
}

const redactField = (key, value) => {
  if (value === null || value === undefined || value === '') return value
  if (CLEAR.includes(key)) return Array.isArray(value) ? [] : ''
  if (typeof value === 'string' || typeof value === 'number') {
    const text = String(value)
    if (NAME_FULL.includes(key)) { const fake = fakeFull(text); names.set(norm(text), fake); note(text, 'name'); return fake }
    if (NAME_FIRST.includes(key)) { note(text, 'name1'); return fakeFirst(text) }
    if (NAME_LAST.includes(key)) { note(text, 'name1'); return fakeLast(text) }
    if (NAME_MIDDLE.includes(key)) return ''
    if (EMAIL_PARTICIPANT.includes(key)) { note(text, 'email'); return OPS.participant }
    if (EMAIL_BILLING.includes(key)) { note(text, 'email'); return OPS.billing }
    if (EMAIL_OTHER.includes(key)) { note(text, 'email'); return fakeEmail(text) }
    if (PHONE.includes(key)) { note(text, 'phone'); return fakePhone(text) }
    if (ADDRESS.includes(key)) { note(text, 'address'); return fakeStreet(text) }
    if (key === 'Suburb') return 'Exampleville'
    if (key in IDS) { note(text, 'id'); return typeof value === 'number' ? fakeNumber(text, IDS[key]) : String(fakeNumber(text, IDS[key])) }
    if (DOB.includes(key)) return typeof value === 'string' ? '1970-01-01' : value
    if (FREE_TEXT.includes(key)) { note(text, 'free'); return text.trim().startsWith('<') ? '<p>Redacted free text.</p>' : 'Redacted free text.' }
  }
  // an object or array under a personal-data key: every string inside it is replaced and recorded
  if (value && typeof value === 'object') return scrubLeaves(key, value)
  return value
}

// ---- pass 1: collect the original names so they can be replaced wherever they appear ------------------
const collectNames = () => {
  db.items.find({ $or: NAME_FULL.map((k) => ({ [`data.${k}`]: { $type: 'string' } })) }, { data: 1 }).forEach((doc) => {
    for (const key of NAME_FULL) { const v = doc.data && doc.data[key]; if (typeof v === 'string' && v.trim()) names.set(norm(v), fakeFull(v)) }
  })
  for (const [collection, field] of [['pdflinks', 'participant'], ['invoicenumbers', 'participant'], ['users', 'name']]) {
    if (!db.getCollectionNames().includes(collection)) continue
    db.getCollection(collection).find({ [field]: { $type: 'string' } }, { [field]: 1 }).forEach((doc) => { const v = doc[field]; if (v && !v.includes('@') && v.trim()) names.set(norm(v), fakeFull(v)) })
  }
}
collectNames()
const addressSubs = new Map()
db.items.find({ $or: ADDRESS.map((k) => ({ [`data.${k}`]: { $type: 'string' } })) }, { data: 1 }).forEach((doc) => {
  for (const key of ADDRESS) { const v = doc.data && doc.data[key]; if (typeof v === 'string' && v.trim().length >= 8 && !IGNORED.has(v.trim())) addressSubs.set(norm(v), fakeStreet(v)) }
})
const businessNames = new Map()
db.businesses.find({}, { name: 1, workspaceId: 1 }).forEach((b) => { if (b.name) businessNames.set(norm(b.name), `Example Care Services ${b.workspaceId}`) })

// the substitutions applied to free strings: names (and their file-name spellings) and business names
const SUBS = []
for (const [orig, fake] of [...names, ...businessNames, ...addressSubs]) {
  if (orig.length < 6 || !orig.includes(' ')) continue
  for (const [from, to] of [[' ', ' '], [' ', '-'], [' ', '_'], [' ', '%20'], [' ', '+']]) SUBS.push([orig.replace(/ /g, from), fake.replace(/ /g, to)])
}
SUBS.sort((a, b) => b[0].length - a[0].length)
const TOKENS = new Set(SUBS.flatMap(([from]) => from.split(/[^a-z0-9]+/).filter((t) => t.length >= 3)))

// index each substitution under its longest token: a substitution can only match text that contains that token,
// so a record is tried against a handful of candidates rather than every substitution
const SUBS_BY_TOKEN = new Map()
SUBS.forEach(([from], i) => {
  const tokens = from.split(/[^a-z0-9]+/).filter((t) => t.length >= 3)
  if (!tokens.length) return
  const longest = tokens.reduce((a, b) => (b.length > a.length ? b : a))
  if (!SUBS_BY_TOKEN.has(longest)) SUBS_BY_TOKEN.set(longest, [])
  SUBS_BY_TOKEN.get(longest).push(i)
})
const candidatesFor = (lower) => {
  const found = new Set()
  for (const t of new Set(lower.split(/[^a-z0-9]+/))) { const hit = SUBS_BY_TOKEN.get(t); if (hit) for (const i of hit) found.add(i) }
  return [...found].sort((a, b) => a - b)
}

const replaceFree = (text) => {
  let out = text
  if (out.includes('@')) {
    out = out.replace(EMAIL, (match) => { if (ALLOWED_EMAIL.test(match)) return match; note(match, 'email'); return fakeEmail(match) })
  }
  out = out.replace(PHONE_IN_TEXT, (match) => { note(match, 'phone'); return fakePhone(match) })
  out = out.replace(LABELLED_ID, (match, label, digits) => { note(digits, 'id'); return `${label}${fakeNumber(digits, 9)}` })
  const lower = out.toLowerCase()
  for (const i of candidatesFor(lower)) {
    const [from, to] = SUBS[i]
    if (!lower.includes(from)) continue
    const re = new RegExp(from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi')
    out = out.replace(re, () => { note(from, 'name'); return to })
  }
  return out
}

print(`SUBS:${SUBS.length} TOKENS:${TOKENS.size}`)
// ---- pass 2: items -------------------------------------------------------------------------------
let changed = 0
let ops = []
const flush = () => { if (ops.length) { db.items.bulkWrite(ops, { ordered: false }); ops = [] } }
const hasName = (json) => json.includes('@') || /(?:\+61|\b0)[\s-]?\d/.test(json) || /registration|provider (?:number|id)|abn|acn|ndis/i.test(json) || json.toLowerCase().split(/[^a-z0-9]+/).some((t) => TOKENS.has(t))
const deepFree = (value) => {
  if (typeof value === 'string') return value.length >= 5 ? replaceFree(value) : value
  if (Array.isArray(value)) return value.map(deepFree)
  if (value && typeof value === 'object') { const out = {}; for (const k of Object.keys(value)) out[k] = deepFree(value[k]); return out }
  return value
}
let seen = 0
db.items.find({}, { data: 1 }).forEach((doc) => {
  if (++seen % 20000 === 0) print(`items ${seen} changed ${changed}`)
  const data = doc.data || {}
  let dirty = false
  for (const key of Object.keys(data)) {
    let value = data[key]
    if (PII_KEYS.has(key)) value = redactField(key, value)
    else if (value !== null && typeof value === 'object' || typeof value === 'string') { const json = JSON.stringify(value); if (hasName(json)) value = deepFree(value) }
    if (JSON.stringify(value) !== JSON.stringify(data[key])) { data[key] = value; dirty = true }
  }
  if (dirty) { ops.push({ updateOne: { filter: { _id: doc._id }, update: { $set: { data } } } }); changed += 1; if (ops.length >= 500) flush() }
})
flush()

// ---- pass 3: every other collection, by key name and by value -------------------------------------
const roleOf = (collection, path) => (collection === 'businesses' && /(^|\.)email$/.test(path) ? OPS.main : null)
const walk = (collection, value, path, parentKey) => {
  if (typeof value === 'number' && /phone|mobile|^abn$|^acn$|^bsb$|^accountNumber$/i.test((path.split('.').pop() || '').replace(/\[\]$/, ''))) {
    const replaced = walk(collection, String(value), path, parentKey)
    return /^[1-9]\d*$/.test(replaced) ? Number(replaced) : replaced
  }
  if (typeof value === 'string') {
    if (value === '') return value
    const key = (path.split('.').pop() || '').replace(/\[\]$/, '')
    if (/pdflink|filekey|^url$|link$/i.test(key)) { note(value, 'link'); return 'https://example.com/redacted/' + H(value).toString(36) + '.pdf' }
    if (/email/i.test(key) && value.includes('@')) { note(value, 'email'); return roleOf(collection, path) || fakeEmail(value) }
    if (/phone|mobile/i.test(key)) { note(value, 'phone'); return fakePhone(value) }
    if (/^(street|streetAddress)$/i.test(key)) { note(value, 'address'); return fakeStreet(value) }
    if (/^suburb$/i.test(key)) return 'Exampleville'
    if (/^postcode$/i.test(key)) return '2000'
    // the replacements keep the format the application validates: ABN 11 digits, ACN 9, BSB 6, account number 8
    if (/^abn$/i.test(key)) { note(value, 'id'); return String(fakeNumber(value, 11)) }
    if (/^(acn|companyRegistrationId)$/i.test(key)) { note(value, 'id'); return String(fakeNumber(value, 9)) }
    if (/^bsb$/i.test(key)) { note(value, 'id'); return String(fakeNumber(value, 6)) }
    if (/^accountNumber$/i.test(key)) { note(value, 'id'); return String(fakeNumber(value, 8)) }
    if (/^(bankName|bankAccountName|accountName|paymentReference)$/i.test(key)) { note(value, 'id'); return 'REDACTED' }
    if (/^avatar$|^photo_url$/i.test(key)) return ''
    // business logos: the files are not in a dump, so a stored path would point at nothing and hang the Business page
    if (/^(defaultLogo|squareLogo|wideLogo)$/i.test(key)) return ''
    if ((collection === 'users' && key === 'name') || (/^(participant|participantName)$/i.test(key))) { if (!value.includes('@') ) { const fake = fakeFull(value); note(value, 'name'); return fake } }
    if (/^(name|legalName)$/i.test(key) && /xeroOrganization|organization/i.test(path)) { note(value, 'business'); return `Example Organisation ${H(value).toString(36)}` }
    if (/(agedcare.*id|careRecipientId|providerid|ndis(number|no|registration)|medicare|dateofbirth|^dob$)/i.test(key)) { note(value, 'id'); return String(fakeNumber(value, 9)) }
    if (/^participant(first|last|middle)?name$/i.test(key) && !value.includes('@')) { note(value, 'name'); return fakeFull(value) }
    if (/^(name|legalName)$/i.test(key) && /businesses|xeroOrganization|after|before|body/.test(`${collection}.${path}`) && businessNames.has(norm(value))) { note(value, 'business'); return businessNames.get(norm(value)) }
    if (/^(password|accessToken|refreshToken|hookSecret|secret|token)$/i.test(key)) return ''
    return replaceFree(value)
  }
  if (Array.isArray(value)) return value.map((x) => walk(collection, x, `${path}[]`, parentKey))
  if (value && typeof value === 'object' && !(value instanceof ObjectId) && !(value instanceof Date) && value.constructor.name !== 'Binary') {
    const out = {}
    for (const k of Object.keys(value)) out[k] = walk(collection, value[k], path ? `${path}.${k}` : k, k)
    return out
  }
  return value
}
const counts = { items: changed }
for (const collection of db.getCollectionNames()) {
  if (collection === 'items' || collection.startsWith('system.')) continue
  let n = 0
  const batch = []
  db.getCollection(collection).find().forEach((doc) => {
    const { _id, ...rest } = doc
    const next = walk(collection, rest, '', '')
    if (JSON.stringify(next) !== JSON.stringify(rest)) { batch.push({ replaceOne: { filter: { _id }, replacement: next } }); n += 1 }
    if (batch.length >= 500) db.getCollection(collection).bulkWrite(batch.splice(0))
  })
  if (batch.length) db.getCollection(collection).bulkWrite(batch)
  counts[collection] = n
}
print(`COUNTS:${JSON.stringify(counts)}`)
for (const entry of leaks) print(`LEAK:${entry.replace(/\n/g, ' ')}`)
