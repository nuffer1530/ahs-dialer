export const MAX_ATTEMPTS = 3
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

export const STATUS_COLORS = {
  'Pending':        { bg: '#EAF3FB', color: '#0D3D5C' },
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
