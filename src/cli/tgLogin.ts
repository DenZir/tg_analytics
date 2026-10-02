/**
 * Logs the analytics' own Telegram account session in — the eyes of the ad
 * post checker (jobs/adChecks.ts).
 *
 * Phone, code and password are typed here, in the terminal, and go nowhere
 * but Telegram: only the session key lands in TG_SESSION_PATH. The session
 * shows up in Telegram as a separate device (Settings → Devices), so it can be
 * revoked on its own.
 *
 *   npm run tg:login               # into TG_SESSION_PATH
 *   npm run tg:login -- --force    # replace a working session
 *
 * In Docker: docker compose run --rm analytics npm run tg:login
 */
import "dotenv/config";
import { createInterface } from "node:readline/promises";
import { accountConfig, createClient, hasLogin } from "../telegram/account.js";

const conf = accountConfig();
if (!conf.ok) {
  console.error(`Нельзя войти: ${conf.reason}. Возьмите их на my.telegram.org → API development tools и впишите в .env.`);
  process.exit(1);
}
const { cfg } = conf;

if (hasLogin(cfg.storage) && !process.argv.includes("--force")) {
  // Overwriting a working session in passing means losing the checker at the
  // worst moment. Make that a separate decision.
  console.error(`В ${cfg.storage} уже есть вход — перезаписывать не буду.\nЕсли эта сессия не нужна: npm run tg:login -- --force`);
  process.exit(1);
}

console.log("Вход в Telegram для проверки рекламных постов. Код и пароль никуда не сохраняются.");
console.log(`Сессия ляжет в ${cfg.storage}${cfg.proxy ? `, через прокси ${cfg.proxy}` : ""}\n`);

const rl = createInterface({ input: process.stdin, output: process.stdout });
const client = createClient(cfg);
try {
  const me = await client.start({
    phone: () => rl.question("Телефон (с +): "),
    code: () => rl.question("Код из Telegram: "),
    password: () => rl.question("Пароль двухфакторной защиты: "),
  });
  console.log(`\nГотово: ${me.displayName} (@${me.username ?? "без юзернейма"}), id ${me.id}`);
  console.log("Чтобы проверять посты в закрытых каналах, этот аккаунт должен в них состоять.");
} finally {
  rl.close();
  await client.destroy();
}
