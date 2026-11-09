/**
 * SQLite có sẵn trong runtime, không thêm gói: `bun:sqlite` (bản aivin.exe đóng gói bằng Bun) hoặc `node:sqlite` (chạy từ npm / mã nguồn,
 * Node ≥ 22.13). Nạp lúc cần (import động) — Node cũ hơn vẫn chạy được phần còn lại của CLI. Trả một lớp mỏng chung: `exec`, `prepare`
 * (`run` / `get` / `all`, tham số theo vị trí), `transaction`, `close`.
 */
export async function openSqlite(file) {
  if (globalThis.Bun) {
    const { Database } = await import('bun:sqlite');
    return wrap(new Database(file, { create: true }));
  }
  // node:sqlite còn gắn nhãn thử nghiệm: bỏ đúng cảnh báo đó, không để nó lẫn vào đầu ra của CLI.
  const emit = process.emitWarning;
  process.emitWarning = (warning, ...rest) => {
    if (/SQLite/i.test(String(warning?.message ?? warning))) return;
    emit.call(process, warning, ...rest);
  };
  try {
    const { DatabaseSync } = await import('node:sqlite');
    return wrap(new DatabaseSync(file));
  } finally {
    process.emitWarning = emit;
  }
}

function wrap(db) {
  const prepare = (sql) => {
    const st = db.prepare(sql);
    return {
      run: (...args) => st.run(...args),
      get: (...args) => st.get(...args) ?? undefined,
      all: (...args) => st.all(...args),
    };
  };
  return {
    exec: (sql) => db.exec(sql),
    prepare,
    /** Chạy `fn` trong một giao dịch (lỗi → huỷ cả khối). */
    transaction(fn) {
      db.exec('BEGIN');
      try {
        const out = fn();
        db.exec('COMMIT');
        return out;
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },
    close: () => db.close(),
  };
}
