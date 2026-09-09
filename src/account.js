import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { GameError, requireThat } from './errors.js';
import { balanceOf, grantRegister } from './wallet.js';

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 登录态 30 天
const KEY_LENGTH = 64;
const NAME_PATTERN = /[\u0000-\u001f\u007f]/g;

function validAccountName(value) {
  requireThat(typeof value === 'string', '请输入昵称');
  const name = value.replace(NAME_PATTERN, '').trim();
  requireThat(name.length >= 1 && [...name].length <= 12, '昵称需要 1–12 个字');
  return name;
}

function validPassword(value) {
  requireThat(typeof value === 'string', '请输入密码');
  requireThat([...value].length >= 6 && [...value].length <= 64, '密码需要 6–64 个字符');
  return value;
}

function hashPassword(password, salt = randomBytes(16).toString('hex')) {
  const hash = scryptSync(password, salt, KEY_LENGTH).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  const candidate = scryptSync(String(password), salt, KEY_LENGTH);
  const expected = Buffer.from(hash, 'hex');
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

function issueSession(db, accountId) {
  const token = randomBytes(32).toString('hex');
  const now = Date.now();
  db.prepare('INSERT INTO sessions (token, account_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .run(token, accountId, now, now + SESSION_TTL_MS);
  return token;
}

export function register(db, name, password) {
  const accountName = validAccountName(name);
  const secret = validPassword(password);
  const id = randomUUID();
  db.transaction(() => {
    try {
      db.prepare('INSERT INTO accounts (id, name, password_hash, created_at) VALUES (?, ?, ?, ?)')
        .run(id, accountName, hashPassword(secret), Date.now());
    } catch (error) {
      if (error && String(error.code).startsWith('SQLITE_CONSTRAINT')) throw new GameError('这个昵称已被注册');
      throw error;
    }
    // 注册一次性赠送 10,000 筹码（REGISTER_GRANT 流水，幂等）
    grantRegister(db, id);
  })();
  return { accountId: id, name: accountName, token: issueSession(db, id), balance: balanceOf(db, id) };
}

export function login(db, name, password) {
  const accountName = validAccountName(name);
  requireThat(typeof password === 'string' && password.length > 0, '请输入密码');
  const account = db.prepare('SELECT * FROM accounts WHERE name = ?').get(accountName);
  requireThat(account && verifyPassword(password, account.password_hash), '昵称或密码不正确');
  requireThat(!account.is_banned, '账号已被封禁');
  return { accountId: account.id, name: account.name, token: issueSession(db, account.id), balance: balanceOf(db, account.id) };
}

export function authenticate(db, token) {
  if (typeof token !== 'string' || !token) return null;
  return db.prepare(`SELECT a.id, a.name, a.is_banned AS isBanned FROM sessions s JOIN accounts a ON a.id = s.account_id
                     WHERE s.token = ? AND s.expires_at > ?`).get(token, Date.now()) ?? null;
}
