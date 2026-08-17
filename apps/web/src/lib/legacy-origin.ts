import {
	LEGACY_WEB_ORIGINS,
	PRODUCTION_WEB_ORIGIN,
} from "@world-issue-tracker/shared";

/** 旧オリジンから来たら新しい入口へ送る対象（#98）。 */
const LEGACY_HOSTS = new Set(
	LEGACY_WEB_ORIGINS.map((origin) => new URL(origin).host),
);

/**
 * 旧オリジンから来たリクエストの転送先を返す（#98）。転送不要なら null。
 *
 * `middleware.ts` から切り出してある。あちらは `@clerk/nextjs/server` を
 * 読み込むが、そのパッケージは Next.js のビルドを前提にしていて `bun test`
 * からは解決できない（`Export named 'clerkMiddleware' not found`）。
 * モジュールごとモックする手もあるが、`bun:test` の `mock.module` は
 * **ファイル単位で閉じない**ため無関係なテストまで巻き込む（実際に落ちた）。
 *
 * 転送するかどうかは Clerk と独立した判断なので、ここに置けば素で試せる。
 *
 * パスとクエリはそのまま維持する。Issue 詳細への直リンクが一覧に飛ばされると、
 * 何を見ようとしていたのか分からなくなる。
 */
export function legacyRedirectTarget(requestUrl: string): string | null {
	const url = new URL(requestUrl);
	if (!LEGACY_HOSTS.has(url.host)) {
		return null;
	}
	return new URL(`${url.pathname}${url.search}`, PRODUCTION_WEB_ORIGIN).href;
}
