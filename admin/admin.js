// Evicted admin dashboard — single-page vanilla JS app that talks to
// Supabase directly via the JS SDK. All writes go through the same RPCs and
// tables as the iOS admin (draft_team, grant_admin, alliance CRUD, etc.), so
// RLS + triggers enforce the same rules whether an action is triggered here
// or in the iOS Admin tab.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.46.0'

// ============================================================
// Config + client
// ============================================================
const SUPABASE_URL = 'https://lnfdawxjyowhwiwbfclq.supabase.co'
const SUPABASE_ANON_KEY = 'sb_publishable_9GPOHW_LyjjMO8B0FDcm8A_4ez1av8x'
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY)

// ============================================================
// State
// ============================================================
const state = {
  session: null,
  isSuperAdmin: false,
  activeSeason: null,
  seasons: [],
  houseguests: [],   // for active season
  evictions: [],
  bonuses: [],
  finale: null,
  admins: [],
  users: [],
}

// ============================================================
// DOM helpers
// ============================================================
const $ = (sel) => document.querySelector(sel)
const $$ = (sel) => document.querySelectorAll(sel)
const el = (tag, attrs = {}, ...children) => {
  const node = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v
    else if (k === 'html') node.innerHTML = v
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v)
    else if (v !== undefined && v !== null) node.setAttribute(k, v)
  }
  for (const child of children) {
    if (child == null) continue
    if (typeof child === 'string') node.appendChild(document.createTextNode(child))
    else node.appendChild(child)
  }
  return node
}

// ============================================================
// Toast + modal
// ============================================================
let toastTimer = null
function toast(msg, variant = '') {
  const t = $('#toast')
  t.textContent = msg
  t.className = `toast ${variant}`
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => t.classList.add('hidden'), 4000)
}

const modal = {
  open(title, bodyEl, onSave) {
    $('#modalTitle').textContent = title
    const body = $('#modalBody')
    body.innerHTML = ''
    body.appendChild(bodyEl)
    $('#modalSaveBtn').textContent = 'Save'
    modal._onSave = onSave
    $('#modalBackdrop').classList.add('open')
  },
  close() {
    $('#modalBackdrop').classList.remove('open')
    modal._onSave = null
  },
  async save() {
    if (modal._onSave) {
      $('#modalSaveBtn').disabled = true
      try {
        const ok = await modal._onSave()
        if (ok !== false) modal.close()
      } finally {
        $('#modalSaveBtn').disabled = false
      }
    } else modal.close()
  },
}
$('#modalCancelBtn').addEventListener('click', () => modal.close())
$('#modalSaveBtn').addEventListener('click', () => modal.save())
$('#modalBackdrop').addEventListener('click', (e) => {
  if (e.target.id === 'modalBackdrop') modal.close()
})

// ============================================================
// Auth flow
// ============================================================
async function sendLoginCode() {
  const email = $('#loginEmail').value.trim()
  if (!email.includes('@')) return toast('Enter a valid email', 'error')
  const btn = $('#sendCodeBtn')
  btn.disabled = true
  btn.innerHTML = '<span class="spinner"></span>'
  const { error } = await supabase.auth.signInWithOtp({ email, options: { shouldCreateUser: false } })
  btn.disabled = false
  btn.textContent = 'Send Code'
  if (error) {
    // shouldCreateUser=false rejects unknown emails — we don't want to allow
    // random signups from the admin page.
    if (String(error.message).toLowerCase().includes('signups not allowed')) {
      return toast("That email isn't registered. Sign up in the iOS app first.", 'error')
    }
    return toast(error.message, 'error')
  }
  $('#loginEmailStep').classList.add('hidden')
  $('#loginCodeStep').classList.remove('hidden')
  $('#loginSub').textContent = `Code sent to ${email}`
  $('#loginCode').focus()
}
async function verifyLoginCode() {
  const email = $('#loginEmail').value.trim()
  const token = $('#loginCode').value.trim()
  if (token.length !== 6) return toast('Enter the 6-digit code', 'error')
  const btn = $('#verifyCodeBtn')
  btn.disabled = true
  btn.innerHTML = '<span class="spinner"></span>'
  const { data, error } = await supabase.auth.verifyOtp({ email, token, type: 'email' })
  btn.disabled = false
  btn.textContent = 'Verify'
  if (error) return toast(error.message, 'error')
  await handleAuthState(data.session)
}
async function signOut() {
  await supabase.auth.signOut()
  state.session = null
  state.isSuperAdmin = false
  await renderAuthUI()
}

$('#sendCodeBtn').addEventListener('click', sendLoginCode)
$('#verifyCodeBtn').addEventListener('click', verifyLoginCode)
$('#backToEmailBtn').addEventListener('click', () => {
  $('#loginCodeStep').classList.add('hidden')
  $('#loginEmailStep').classList.remove('hidden')
  $('#loginSub').textContent = 'Sign in with your admin email.'
  $('#loginCode').value = ''
})
$('#signOutBtn').addEventListener('click', signOut)
$('#signOutFromDenied').addEventListener('click', signOut)

async function handleAuthState(session) {
  state.session = session
  if (!session) {
    state.isSuperAdmin = false
  } else {
    // Check super-admin using the helper RPC from migration 0013
    const { data, error } = await supabase.rpc('is_super_admin')
    state.isSuperAdmin = !error && !!data
  }
  await renderAuthUI()
}

async function renderAuthUI() {
  const loginWrap = $('#loginWrap')
  const dashboard = $('#dashboard')
  const deniedEl = $('#loginDenied')
  const emailStep = $('#loginEmailStep')
  const codeStep = $('#loginCodeStep')

  loginWrap.classList.add('hidden')
  dashboard.classList.add('hidden')
  deniedEl.classList.add('hidden')

  if (!state.session) {
    // Not signed in — show email step
    emailStep.classList.remove('hidden')
    codeStep.classList.add('hidden')
    loginWrap.classList.remove('hidden')
    return
  }
  if (!state.isSuperAdmin) {
    // Signed in but not a super admin
    emailStep.classList.add('hidden')
    codeStep.classList.add('hidden')
    deniedEl.classList.remove('hidden')
    $('#loginSub').textContent = state.session.user.email
    loginWrap.classList.remove('hidden')
    return
  }
  // Signed in as super admin
  $('#whoami').textContent = state.session.user.email
  dashboard.classList.remove('hidden')
  await loadEverything()
}

// ============================================================
// Tab switching
// ============================================================
$$('.tabs button').forEach((btn) => {
  btn.addEventListener('click', () => {
    const tab = btn.dataset.tab
    $$('.tabs button').forEach((b) => b.classList.toggle('active', b === btn))
    $$('section').forEach((s) => s.classList.toggle('active', s.id === `section-${tab}`))
  })
})

// ============================================================
// Data loading
// ============================================================
async function loadEverything() {
  await loadSeasons()
  if (state.activeSeason) {
    await Promise.all([
      loadHouseguests(),
      loadEvictions(),
      loadBonuses(),
      loadFinale(),
    ])
  }
  await Promise.all([loadAdmins(), loadUsers()])
  renderAll()
}

async function loadSeasons() {
  const { data, error } = await supabase.from('seasons').select().order('created_at', { ascending: false })
  if (error) return toast(error.message, 'error')
  state.seasons = data || []
  state.activeSeason = state.seasons.find((s) => s.is_active) || null
}
async function loadHouseguests() {
  const { data, error } = await supabase.from('houseguests').select().eq('season_id', state.activeSeason.id).order('first_name')
  if (error) return toast(error.message, 'error')
  state.houseguests = data || []
}
async function loadEvictions() {
  const { data, error } = await supabase.from('evictions').select().eq('season_id', state.activeSeason.id).order('eviction_number')
  if (error) return toast(error.message, 'error')
  state.evictions = data || []
}
async function loadBonuses() {
  const { data, error } = await supabase
    .from('houseguest_bonuses')
    .select('*, houseguests(first_name, season_id)')
  if (error) return toast(error.message, 'error')
  state.bonuses = (data || []).filter((b) => b.houseguests?.season_id === state.activeSeason.id)
}
async function loadFinale() {
  const { data, error } = await supabase.from('finale_results').select().eq('season_id', state.activeSeason.id).maybeSingle()
  if (error) return toast(error.message, 'error')
  state.finale = data
}
async function loadAdmins() {
  const { data: roles } = await supabase.from('admin_roles').select('user_id, season_id')
  if (!roles) return
  const userIds = [...new Set(roles.map((r) => r.user_id))]
  if (userIds.length === 0) { state.admins = []; return }
  const { data: users } = await supabase.from('users_public').select().in('id', userIds)
  state.admins = (users || []).map((u) => ({
    ...u,
    is_super: roles.some((r) => r.user_id === u.id && r.season_id === null),
  }))
}
async function loadUsers() {
  const { data } = await supabase.from('users_public').select().order('username')
  state.users = data || []
}

// ============================================================
// Rendering
// ============================================================
function renderAll() {
  renderSeasonSection()
  renderHouseguestSection()
  renderEvictionSection()
  renderBonusSection()
  renderFinaleSection()
  renderAdminSection()
}

// -------------------- Seasons --------------------
function renderSeasonSection() {
  const info = $('#seasonActiveInfo')
  if (state.activeSeason) {
    info.innerHTML = `<strong style="color: var(--yellow);">${escapeHtml(state.activeSeason.name)}</strong> · ${state.houseguests.length} houseguests · ${state.evictions.length} evictions`
  } else {
    info.textContent = 'No active season. Create one and activate it.'
  }
  const list = $('#seasonList')
  list.innerHTML = ''
  for (const s of state.seasons) {
    const badge = s.is_active ? el('span', { class: 'badge active' }, 'ACTIVE') : null
    const actions = el('div', { class: 'li-actions' })
    if (!s.is_active) {
      actions.appendChild(el('button', {
        class: 'secondary',
        onclick: () => activateSeason(s.id),
      }, 'Activate'))
    }
    list.appendChild(el('div', { class: 'list-item' },
      el('div', { class: 'li-main' }, s.name, badge),
      actions,
    ))
  }
}
async function activateSeason(id) {
  if (!confirm('Activate this season? The current active season will become inactive.')) return
  const { error: e1 } = await supabase.from('seasons').update({ is_active: false }).eq('is_active', true)
  if (e1) return toast(e1.message, 'error')
  const { error: e2 } = await supabase.from('seasons').update({ is_active: true }).eq('id', id)
  if (e2) return toast(e2.message, 'error')
  toast('Season activated', 'success')
  await loadEverything()
}
$('#createSeasonBtn').addEventListener('click', async () => {
  const name = $('#newSeasonName').value.trim()
  const premiere = $('#newSeasonPremiere').value || null
  if (!name) return toast('Name is required', 'error')
  const row = { name, is_active: false }
  if (premiere) row.premiere_date = premiere
  const { error } = await supabase.from('seasons').insert(row)
  if (error) return toast(error.message, 'error')
  $('#newSeasonName').value = ''
  $('#newSeasonPremiere').value = ''
  toast('Season created (not yet active)', 'success')
  await loadSeasons()
  renderSeasonSection()
})

// -------------------- Houseguests --------------------
function renderHouseguestSection() {
  const list = $('#houseguestList')
  list.innerHTML = ''
  if (!state.activeSeason) {
    list.appendChild(el('div', { class: 'empty' }, 'Set an active season first.'))
    return
  }
  if (state.houseguests.length === 0) {
    list.appendChild(el('div', { class: 'empty' }, 'No houseguests yet. Add one or bulk import.'))
    return
  }
  for (const hg of state.houseguests) {
    const avatarHtml = hg.avatar_url
      ? el('img', { class: 'li-avatar', src: hg.avatar_url, alt: '' })
      : el('div', { class: 'li-avatar', style: 'display:flex; align-items:center; justify-content:center; font-size:12px; color:var(--white-muted);' }, hg.first_name?.[0] || '?')
    const badge = hg.is_evicted ? el('span', { class: 'badge evicted' }, `EVICTED #${hg.evicted_at_eviction_number ?? '?'}`) : null
    list.appendChild(el('div', { class: 'list-item' },
      el('div', { class: 'li-main' }, avatarHtml, hg.first_name, badge, el('span', { class: 'li-meta' }, hg.occupation || '')),
      el('div', { class: 'li-actions' },
        el('button', { class: 'secondary', onclick: () => openHouseguestModal(hg) }, 'Edit'),
        el('button', { class: 'danger', onclick: () => deleteHouseguest(hg) }, 'Delete'),
      ),
    ))
  }
}
$('#addHouseguestBtn').addEventListener('click', () => openHouseguestModal(null))
function openHouseguestModal(existing) {
  if (!state.activeSeason) return toast('Set an active season first', 'error')
  const body = document.createElement('div')
  body.innerHTML = `
    <div class="form-row">
      <div><label>First name *</label><input type="text" id="hgFirst" value="${escapeAttr(existing?.first_name ?? '')}"></div>
      <div><label>Full name *</label><input type="text" id="hgFull" value="${escapeAttr(existing?.full_name ?? '')}"></div>
    </div>
    <div class="form-row three">
      <div><label>Age</label><input type="number" id="hgAge" value="${existing?.age ?? ''}"></div>
      <div><label>Hometown</label><input type="text" id="hgHometown" value="${escapeAttr(existing?.hometown ?? '')}"></div>
      <div><label>Occupation</label><input type="text" id="hgOccupation" value="${escapeAttr(existing?.occupation ?? '')}"></div>
    </div>
    <div class="form-field"><label>Avatar URL</label><input type="url" id="hgAvatarUrl" value="${escapeAttr(existing?.avatar_url ?? '')}" placeholder="https://..."></div>
    <div class="form-field"><label>Or upload avatar</label><input type="file" id="hgAvatarFile" accept="image/*"></div>
    <div class="form-field"><label>Bio</label><textarea id="hgBio">${escapeHtml(existing?.bio ?? '')}</textarea></div>
  `
  modal.open(existing ? `Edit ${existing.first_name}` : 'Add Houseguest', body, async () => {
    const first_name = $('#hgFirst').value.trim()
    const full_name = $('#hgFull').value.trim()
    if (!first_name || !full_name) { toast('First + full name required', 'error'); return false }
    const row = {
      first_name, full_name,
      age: parseInt($('#hgAge').value) || null,
      hometown: $('#hgHometown').value.trim() || null,
      occupation: $('#hgOccupation').value.trim() || null,
      bio: $('#hgBio').value.trim() || null,
      avatar_url: $('#hgAvatarUrl').value.trim() || null,
      season_id: state.activeSeason.id,
    }

    // If a file was picked, upload to storage first
    const file = $('#hgAvatarFile').files?.[0]
    if (file) {
      const hgId = existing?.id || crypto.randomUUID()
      const ext = file.name.split('.').pop() || 'jpg'
      const path = `hg/${hgId.toLowerCase()}/avatar.${ext}`
      const { error: upErr } = await supabase.storage.from('avatars').upload(path, file, { upsert: true, contentType: file.type })
      if (upErr) { toast(`Upload failed: ${upErr.message}`, 'error'); return false }
      const { data: { publicUrl } } = supabase.storage.from('avatars').getPublicUrl(path)
      row.avatar_url = `${publicUrl}?t=${Date.now()}`
      if (!existing) row.id = hgId
    }

    if (existing) {
      const { error } = await supabase.from('houseguests').update(row).eq('id', existing.id)
      if (error) { toast(error.message, 'error'); return false }
    } else {
      const { error } = await supabase.from('houseguests').insert(row)
      if (error) { toast(error.message, 'error'); return false }
    }
    toast(existing ? 'Updated' : 'Added', 'success')
    await loadHouseguests()
    renderHouseguestSection()
    renderFinaleSection()  // finale dropdowns depend on HG list
    return true
  })
}
async function deleteHouseguest(hg) {
  if (!confirm(`Delete ${hg.first_name}? This will also remove any team picks referencing them.`)) return
  const { error } = await supabase.from('houseguests').delete().eq('id', hg.id)
  if (error) return toast(error.message, 'error')
  toast('Deleted', 'success')
  await loadHouseguests()
  renderHouseguestSection()
  renderFinaleSection()
}
$('#bulkImportBtn').addEventListener('click', async () => {
  if (!state.activeSeason) return toast('Set an active season first', 'error')
  let arr
  try {
    arr = JSON.parse($('#bulkImportJson').value)
  } catch (e) {
    return toast('Invalid JSON', 'error')
  }
  if (!Array.isArray(arr)) return toast('JSON must be an array', 'error')
  const rows = arr.map((h) => ({
    first_name: h.first_name,
    full_name: h.full_name || h.first_name,
    age: h.age ?? null,
    hometown: h.hometown ?? null,
    occupation: h.occupation ?? null,
    bio: h.bio ?? null,
    avatar_url: h.avatar_url ?? null,
    season_id: state.activeSeason.id,
  }))
  const invalid = rows.find((r) => !r.first_name)
  if (invalid) return toast('Every item needs at least first_name', 'error')
  const { error } = await supabase.from('houseguests').insert(rows)
  if (error) return toast(error.message, 'error')
  $('#bulkImportJson').value = ''
  toast(`Imported ${rows.length} houseguests`, 'success')
  await loadHouseguests()
  renderHouseguestSection()
  renderFinaleSection()
})

// -------------------- Evictions --------------------
function renderEvictionSection() {
  const list = $('#evictionList')
  list.innerHTML = ''
  if (!state.activeSeason) {
    list.appendChild(el('div', { class: 'empty' }, 'Set an active season first.'))
    return
  }
  if (state.evictions.length === 0) {
    list.appendChild(el('div', { class: 'empty' }, 'No evictions yet.'))
    return
  }
  const hgById = Object.fromEntries(state.houseguests.map((h) => [h.id, h]))
  for (const e of state.evictions) {
    const evictedName = e.evicted_houseguest_id ? hgById[e.evicted_houseguest_id]?.first_name : 'not set'
    const hoh = e.hoh_winner_id ? hgById[e.hoh_winner_id]?.first_name : '—'
    list.appendChild(el('div', { class: 'list-item' },
      el('div', { class: 'li-main' },
        `Eviction #${e.eviction_number}`,
        el('span', { class: 'li-meta' }, `HOH: ${hoh} · Evicted: ${evictedName}`)),
      el('div', { class: 'li-actions' },
        el('button', { class: 'secondary', onclick: () => openEvictionModal(e) }, 'Edit'),
        el('button', { class: 'danger', onclick: () => deleteEviction(e) }, 'Delete'),
      ),
    ))
  }
}
$('#addEvictionBtn').addEventListener('click', () => openEvictionModal(null))
function openEvictionModal(existing) {
  if (!state.activeSeason) return toast('Set an active season first', 'error')
  const nextNum = existing?.eviction_number ?? (Math.max(0, ...state.evictions.map((e) => e.eviction_number)) + 1)
  const hgOptions = state.houseguests.map((h) => ({ id: h.id, label: h.first_name }))

  const body = document.createElement('div')
  body.innerHTML = `
    <div class="form-row">
      <div><label>Eviction # *</label><input type="number" id="evNum" value="${nextNum}"></div>
      <div><label>HOH competition</label><input type="text" id="evHohComp" value="${escapeAttr(existing?.hoh_competition_name ?? '')}"></div>
    </div>
    <div class="form-field"><label>HOH winner</label>${selectHtml('evHoh', hgOptions, existing?.hoh_winner_id)}</div>
    <div class="form-row three">
      <div><label>Nominee 1</label>${selectHtml('evNom1', hgOptions, existing?.nominee_1_id)}</div>
      <div><label>Nominee 2</label>${selectHtml('evNom2', hgOptions, existing?.nominee_2_id)}</div>
      <div><label>Nominee 3</label>${selectHtml('evNom3', hgOptions, existing?.nominee_3_id)}</div>
    </div>
    <div class="form-row">
      <div><label>POV competition</label><input type="text" id="evPovComp" value="${escapeAttr(existing?.pov_competition_name ?? '')}"></div>
      <div><label>POV winner</label>${selectHtml('evPov', hgOptions, existing?.pov_winner_id)}</div>
    </div>
    <div class="form-row">
      <div><label>POV used?</label>
        <select id="evPovUsed">
          <option value="">— unknown —</option>
          <option value="true" ${existing?.pov_used === true ? 'selected' : ''}>Used</option>
          <option value="false" ${existing?.pov_used === false ? 'selected' : ''}>Not used</option>
        </select>
      </div>
      <div><label>POV removed</label>${selectHtml('evPovRemoved', hgOptions, existing?.pov_removed_id)}</div>
    </div>
    <div class="form-field"><label>POV replacement</label>${selectHtml('evPovReplace', hgOptions, existing?.pov_replacement_id)}</div>
    <div class="form-row">
      <div><label>BB competition</label><input type="text" id="evBbComp" value="${escapeAttr(existing?.bb_competition_name ?? '')}"></div>
      <div><label>BB winner</label>${selectHtml('evBb', hgOptions, existing?.bb_winner_id)}</div>
    </div>
    <div class="form-field"><label>Evicted houseguest</label>${selectHtml('evEvicted', hgOptions, existing?.evicted_houseguest_id)}</div>
    <div class="form-row">
      <div><label>Vote for eviction</label><input type="number" id="evVoteFor" value="${existing?.vote_for ?? ''}"></div>
      <div><label>Vote against eviction</label><input type="number" id="evVoteAgainst" value="${existing?.vote_against ?? ''}"></div>
    </div>
  `
  modal.open(existing ? `Edit Eviction #${existing.eviction_number}` : 'Add Eviction', body, async () => {
    const povUsedVal = $('#evPovUsed').value
    const row = {
      season_id: state.activeSeason.id,
      eviction_number: parseInt($('#evNum').value) || null,
      hoh_competition_name: $('#evHohComp').value.trim() || null,
      hoh_winner_id: $('#evHoh').value || null,
      nominee_1_id: $('#evNom1').value || null,
      nominee_2_id: $('#evNom2').value || null,
      nominee_3_id: $('#evNom3').value || null,
      pov_competition_name: $('#evPovComp').value.trim() || null,
      pov_winner_id: $('#evPov').value || null,
      pov_used: povUsedVal === '' ? null : povUsedVal === 'true',
      pov_removed_id: $('#evPovRemoved').value || null,
      pov_replacement_id: $('#evPovReplace').value || null,
      bb_competition_name: $('#evBbComp').value.trim() || null,
      bb_winner_id: $('#evBb').value || null,
      evicted_houseguest_id: $('#evEvicted').value || null,
      vote_for: parseInt($('#evVoteFor').value) || null,
      vote_against: parseInt($('#evVoteAgainst').value) || null,
    }
    if (!row.eviction_number) { toast('Eviction # is required', 'error'); return false }
    if (existing) {
      const { error } = await supabase.from('evictions').update(row).eq('id', existing.id)
      if (error) { toast(error.message, 'error'); return false }
    } else {
      const { error } = await supabase.from('evictions').insert(row)
      if (error) { toast(error.message, 'error'); return false }
    }
    toast('Saved', 'success')
    await Promise.all([loadEvictions(), loadHouseguests()])
    renderEvictionSection()
    renderHouseguestSection()
    return true
  })
}
async function deleteEviction(e) {
  if (!confirm(`Delete Eviction #${e.eviction_number}?`)) return
  const { error } = await supabase.from('evictions').delete().eq('id', e.id)
  if (error) return toast(error.message, 'error')
  toast('Deleted', 'success')
  await Promise.all([loadEvictions(), loadHouseguests()])
  renderEvictionSection()
  renderHouseguestSection()
}

// -------------------- Bonuses --------------------
function renderBonusSection() {
  const list = $('#bonusList')
  list.innerHTML = ''
  if (!state.activeSeason) {
    list.appendChild(el('div', { class: 'empty' }, 'Set an active season first.'))
    return
  }
  if (state.bonuses.length === 0) {
    list.appendChild(el('div', { class: 'empty' }, 'No bonuses yet.'))
    return
  }
  const hgById = Object.fromEntries(state.houseguests.map((h) => [h.id, h]))
  for (const b of state.bonuses) {
    const name = hgById[b.houseguest_id]?.first_name || '?'
    list.appendChild(el('div', { class: 'list-item' },
      el('div', { class: 'li-main' },
        `${name} · ${b.points > 0 ? '+' : ''}${b.points}`,
        el('span', { class: 'li-meta' }, `${b.label} · Eviction #${b.eviction_number}`)),
      el('div', { class: 'li-actions' },
        el('button', { class: 'secondary', onclick: () => openBonusModal(b) }, 'Edit'),
        el('button', { class: 'danger', onclick: () => deleteBonus(b) }, 'Delete'),
      ),
    ))
  }
}
$('#addBonusBtn').addEventListener('click', () => openBonusModal(null))
function openBonusModal(existing) {
  if (!state.activeSeason) return toast('Set an active season first', 'error')
  const hgOptions = state.houseguests.map((h) => ({ id: h.id, label: h.first_name }))
  const body = document.createElement('div')
  body.innerHTML = `
    <div class="form-field"><label>Houseguest *</label>${selectHtml('bonusHg', hgOptions, existing?.houseguest_id)}</div>
    <div class="form-row three">
      <div><label>Eviction #</label><input type="number" id="bonusEv" value="${existing?.eviction_number ?? ''}"></div>
      <div><label>Points</label><input type="number" id="bonusPts" value="${existing?.points ?? ''}"></div>
      <div><label>Label</label><input type="text" id="bonusLabel" value="${escapeAttr(existing?.label ?? '')}"></div>
    </div>
  `
  modal.open(existing ? 'Edit Bonus' : 'Add Bonus', body, async () => {
    const row = {
      houseguest_id: $('#bonusHg').value || null,
      eviction_number: parseInt($('#bonusEv').value) || null,
      points: parseInt($('#bonusPts').value) || null,
      label: $('#bonusLabel').value.trim() || null,
    }
    if (!row.houseguest_id || row.eviction_number == null || row.points == null || !row.label) {
      toast('All fields required', 'error'); return false
    }
    if (existing) {
      const { error } = await supabase.from('houseguest_bonuses').update(row).eq('id', existing.id)
      if (error) { toast(error.message, 'error'); return false }
    } else {
      const { error } = await supabase.from('houseguest_bonuses').insert(row)
      if (error) { toast(error.message, 'error'); return false }
    }
    toast('Saved', 'success')
    await loadBonuses()
    renderBonusSection()
    return true
  })
}
async function deleteBonus(b) {
  if (!confirm(`Delete bonus "${b.label}"?`)) return
  const { error } = await supabase.from('houseguest_bonuses').delete().eq('id', b.id)
  if (error) return toast(error.message, 'error')
  toast('Deleted', 'success')
  await loadBonuses()
  renderBonusSection()
}

// -------------------- Finale --------------------
function renderFinaleSection() {
  const selects = ['finaleWinner', 'finaleRunnerUp', 'finaleAfp']
  const options = state.houseguests.map((h) => `<option value="${h.id}">${escapeHtml(h.first_name)}</option>`).join('')
  const current = { finaleWinner: state.finale?.winner_id, finaleRunnerUp: state.finale?.runner_up_id, finaleAfp: state.finale?.afp_winner_id }
  for (const id of selects) {
    const sel = $(`#${id}`)
    sel.innerHTML = `<option value="">— none —</option>${options}`
    if (current[id]) sel.value = current[id]
  }
}
$('#saveFinaleBtn').addEventListener('click', async () => {
  if (!state.activeSeason) return toast('Set an active season first', 'error')
  const row = {
    season_id: state.activeSeason.id,
    winner_id: $('#finaleWinner').value || null,
    runner_up_id: $('#finaleRunnerUp').value || null,
    afp_winner_id: $('#finaleAfp').value || null,
  }
  const { error } = await supabase.from('finale_results').upsert(row, { onConflict: 'season_id' })
  if (error) return toast(error.message, 'error')
  toast('Finale saved', 'success')
  await loadFinale()
  renderFinaleSection()
})

// -------------------- Admins --------------------
function renderAdminSection() {
  const list = $('#adminList')
  list.innerHTML = ''
  if (state.admins.length === 0) {
    list.appendChild(el('div', { class: 'empty' }, 'No admins.'))
  } else {
    for (const a of state.admins) {
      const badge = a.is_super ? el('span', { class: 'badge creator' }, 'SUPER') : null
      list.appendChild(el('div', { class: 'list-item' },
        el('div', { class: 'li-main' }, a.username, badge),
        el('div', { class: 'li-actions' },
          el('button', { class: 'danger', onclick: () => revokeAdmin(a) }, 'Revoke'),
        ),
      ))
    }
  }
  const promoteSelect = $('#promoteUserSelect')
  const adminIds = new Set(state.admins.map((a) => a.id))
  const nonAdmins = state.users.filter((u) => !adminIds.has(u.id))
  promoteSelect.innerHTML = `<option value="">— select —</option>` + nonAdmins.map((u) => `<option value="${u.id}">${escapeHtml(u.username)}</option>`).join('')
}
$('#promoteAdminBtn').addEventListener('click', async () => {
  const uid = $('#promoteUserSelect').value
  if (!uid) return toast('Pick a user', 'error')
  const { error } = await supabase.rpc('grant_admin', { p_user_id: uid })
  if (error) return toast(error.message, 'error')
  toast('Admin granted', 'success')
  await Promise.all([loadAdmins(), loadUsers()])
  renderAdminSection()
})
async function revokeAdmin(a) {
  if (!confirm(`Revoke admin from ${a.username}?`)) return
  const { error } = await supabase.rpc('revoke_admin', { p_user_id: a.id })
  if (error) return toast(error.message, 'error')
  toast('Admin revoked', 'success')
  await Promise.all([loadAdmins(), loadUsers()])
  renderAdminSection()
}

// ============================================================
// Helpers
// ============================================================
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}
function escapeAttr(s) { return escapeHtml(s) }
function selectHtml(id, options, current) {
  const opts = [`<option value="">— none —</option>`, ...options.map((o) => `<option value="${o.id}" ${o.id === current ? 'selected' : ''}>${escapeHtml(o.label)}</option>`)]
  return `<select id="${id}">${opts.join('')}</select>`
}

// ============================================================
// Boot
// ============================================================
supabase.auth.onAuthStateChange((_event, session) => {
  handleAuthState(session)
})
;(async () => {
  const { data } = await supabase.auth.getSession()
  await handleAuthState(data.session)
})()
