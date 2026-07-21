// Live binding — opsConfig.js overwrites this from app_settings.
export let MAX_ATTEMPTS = 3
export const setMaxAttempts = (n) => { if (Number(n) > 0) MAX_ATTEMPTS = Math.round(Number(n)) }

// What a rep is engaged on, shown alongside their status on the Live Dashboard
// and the floor TV. Status says "On Call"; this says what kind of call it is.
// One definition so the two screens can't drift into different colour schemes.
export const INTERACTION_COLORS = {
  Inbound:  '#3b82f6',
  Outbound: '#8b5cf6',
  Lead:     '#ef4444',
  Text:     '#14b8a6',
  Email:    '#f59e0b',
}
export const DONE_OUTCOMES = ['Booked', 'Not Interested', 'DNC', 'Bad Data']
export const ACTIVE_STATUSES = ['Pending', 'No Answer', 'Voicemail']

export const OUTCOMES = [
  { id: 'No Answer', emoji: '📵' },
  { id: 'Voicemail', emoji: '📨' },
  { id: 'Booked', emoji: '✅' },
  { id: 'Not Interested', emoji: '🚫' },
  { id: 'DNC', emoji: '⛔' },
  { id: 'Bad Data', emoji: '❓' },
]

// On a live INBOUND call, No Answer / Voicemail / Bad Data are nonsense —
// the rep either books or classifies what the call was. Notes + the chosen
// classification sync to ServiceTitan exactly like outbound outcomes.
export const INBOUND_OUTCOMES = [
  { id: 'Booked', emoji: '✅' },
  { id: 'Rescheduled', emoji: '🔁' },
  { id: 'Canceled Appt', emoji: '🗓️' },
  { id: 'Question / Info', emoji: '💬' },
  { id: 'Not Booked - Price', emoji: '💲' },
  { id: 'Wrong Number', emoji: '📵' },
]

export const STATUS_COLORS = {
  'Pending':        { bg: '#EAF3FB', color: '#0D3D5C' },
  'Rescheduled':    { bg: '#EAF3FB', color: '#0D3D5C' },
  'Canceled Appt':  { bg: '#FBF3E0', color: '#8A5A00' },
  'Question / Info':{ bg: '#EAF3FB', color: '#0D3D5C' },
  'Not Booked - Price': { bg: '#FBF3E0', color: '#8A5A00' },
  'Wrong Number':   { bg: '#F3F4F6', color: '#6B7280' },
  'No Answer':      { bg: '#FBF3E0', color: '#8A5A00' },
  'Voicemail':      { bg: '#F0ECFB', color: '#5B3FA0' },
  'Booked':         { bg: '#EAF5EE', color: '#2E7D52' },
  'Not Interested': { bg: '#FBEEEA', color: '#B5341A' },
  'DNC':            { bg: '#FBE8E4', color: '#5F1C0A' },
  'Bad Data':       { bg: '#F0EEE9', color: '#6B6760' },
  'Max Attempts':   { bg: '#F0ECFB', color: '#5B3FA0' },
}

export const PROG_COLORS = {
  'Booked': '#2E7D52', 'Not Interested': '#B5341A', 'DNC': '#5F1C0A',
  'Bad Data': '#9E9B96', 'No Answer': '#C87800', 'Voicemail': '#5B3FA0', 'Max Attempts': '#3F27A0',
}

export const COL_MAP = {
  name:    ['name','fullname','customername','customer','firstname'],
  phone:   ['phone','phonenumber','mobile','cell','telephone','mobilephone','homephone'],
  email:   ['email','emailaddress','mail'],
  address: ['address','streetaddress','address1','street'],
  city:    ['city'],
  state:   ['state','st'],
  zip:     ['zip','zipcode','postalcode'],
  source:  ['source','leadsource'],
  notes:   ['notes','note','comments'],
  extid:   ['customerid','id','custid','accountnumber','accountid'],
}
