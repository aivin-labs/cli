/**
 * Nét mặt theo emoji trong câu trả lời của Aivin (02/11/2026): AI đáp "Mình xin lỗi 😔…" → linh vật cụp mắt cúi đầu, "Xong rồi 🎉" → nhảy
 * mừng. Emoji do chính model chọn theo ngữ cảnh nên dùng được mọi ngôn ngữ, không tốn thêm lượt gọi AI, không dò từ khoá.
 *
 * Chỉ xét câu chốt (không xét chữ đang chạy). Bỏ emoji trong khối code / mã nội dòng và emoji đầu dòng khi câu trả lời là danh sách
 * (≥ 2 dòng mở đầu bằng emoji, kiểu ✅ / 📌) — đó là dấu đầu dòng, không phải cảm xúc. Nhiều emoji có nghĩa → lấy cái cuối (giọng kết câu).
 * Emoji không có trong bảng (✅, 📄…) không tính.
 */

export const Mood = Object.freeze({
  SAD: 'sad', CRY: 'cry', SHEEPISH: 'sheepish', HAPPY: 'happy', CELEBRATE: 'celebrate', SURPRISED: 'surprised', CURIOUS: 'curious',
});

/** Mood buồn / khóc / ngượng: không nhảy mừng "xong", về thẳng chờ việc sau cử chỉ. */
export const SUBDUED_MOODS = new Set([Mood.SAD, Mood.CRY, Mood.SHEEPISH]);

const MOOD_EMOJI = {
  [Mood.SAD]: '😔😞😟🥺😥😓😿💔☹🙁😕😣😖',
  [Mood.CRY]: '😭😢🥲',
  [Mood.SHEEPISH]: '😅😬🙈🫣😳',
  [Mood.HAPPY]: '😊😄😁😃😀🙂🤗😍🥰😘❤💖💙👍🙌👏☺😌',
  [Mood.CELEBRATE]: '🎉🥳🎊✨🏆🚀💪',
  [Mood.SURPRISED]: '😮😲😯🤯😱',
  [Mood.CURIOUS]: '🤔🧐',
};
const MOOD_OF = new Map(Object.entries(MOOD_EMOJI).flatMap(([mood, list]) => [...list].map((e) => [e, mood])));

/** Lệnh `gesture` cho cửa sổ: cử chỉ của rig (rigSource.mjs Play) + nét mặt (bot.mjs BOT_FACES) giữ trong `sec` giây. */
export const MOOD_GESTURE = Object.freeze({
  [Mood.SAD]: { g: 'sad', face: 'sad', sec: 2.4 },
  [Mood.CRY]: { g: 'cry', face: 'cry', sec: 3.2 },
  [Mood.SHEEPISH]: { g: 'sheepish', face: 'sheepish', sec: 1.6 },
  [Mood.HAPPY]: { g: 'giggle', face: 'hello', sec: 1.4 },
  [Mood.CELEBRATE]: { g: 'wave', face: 'star', sec: 2 },
  [Mood.SURPRISED]: { g: 'startle', face: 'waiting', sec: 1 },
  [Mood.CURIOUS]: { g: 'ack', face: 'curious', sec: 1.6 },
});

const EMOJI = /\p{Extended_Pictographic}(?:️|\p{Emoji_Modifier}|‍\p{Extended_Pictographic}️?)*/gu;
const LINE_START_EMOJI = /^\s*\p{Extended_Pictographic}/u;

/** Emoji chỉ cảm xúc trong `text` → Mood, không có → null. */
export function moodOf(text) {
  if (typeof text !== 'string' || !text) return null;
  const plain = text.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`\n]*`/g, ' ');
  const lines = plain.split('\n');
  const isList = lines.filter((l) => LINE_START_EMOJI.test(l)).length >= 2;
  let mood = null;
  for (const line of lines) {
    for (const m of line.matchAll(EMOJI)) {
      if (isList && !line.slice(0, m.index).trim()) continue;
      const found = MOOD_OF.get(String.fromCodePoint(m[0].codePointAt(0)));
      if (found) mood = found;
    }
  }
  return mood;
}
