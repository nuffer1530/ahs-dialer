// Renders whatever's in profiles.avatar: an uploaded photo (data: / http / path),
// an emoji, or — falling back — the first letter of the name. Drops into the
// existing circular avatar containers; a photo fills the circle, emoji/letter
// still use the parent's font size.
export default function Avatar({ avatar, name }) {
  const isImg = typeof avatar === 'string' && /^(data:|https?:|\/)/.test(avatar)
  if (isImg) {
    return <img src={avatar} alt="" draggable="false"
      style={{ width:'100%', height:'100%', objectFit:'cover', borderRadius:'50%', display:'block' }} />
  }
  if (avatar) return <>{avatar}</>
  return <>{(name || '?').trim()[0]?.toUpperCase() || '?'}</>
}
