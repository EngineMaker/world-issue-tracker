import { clerkMiddleware } from "@clerk/nextjs/server";
import {
	LEGACY_WEB_ORIGINS,
	PRODUCTION_WEB_ORIGIN,
} from "@world-issue-tracker/shared";
import { NextResponse } from "next/server";
import { legacyRedirectTarget } from "./lib/legacy-origin";

/*
 * `authorizedParties` を明示する（#98）。理由は API 側
 * （`apps/api/src/middleware/clerk.ts`）と同じで、指定しないと同じ root
 * ドメイン配下の別サブドメインが侵害されたときに、そこで作られたセッションが
 * このアプリでも通ってしまう。`emaker.dev` は reactions.emaker.dev と
 * ゾーンを共有しているため、この対策が実際に意味を持つ。
 */
const withClerk = clerkMiddleware({
	authorizedParties: [
		"http://localhost:3000",
		PRODUCTION_WEB_ORIGIN,
		...LEGACY_WEB_ORIGINS,
	],
});

/*
 * 旧オリジンへのアクセスを新しい入口へ 308 で送る（#98）。
 *
 * 独自ドメインへ移したあとも、旧 URL のブックマークや貼られたリンクは残る。
 * 放置すると「以前見えていたページが開かない」だけの状態になるので、移動先へ送る。
 *
 * 308（Permanent Redirect）にしているのは、301 と違ってメソッドと本文を
 * 変えずに引き継ぐため。誤って POST が GET に化けると、投稿が静かに消える。
 *
 * Clerk のミドルウェアより **手前** に置くこと。旧オリジンのセッションを
 * 解決しても、行き先が変わるなら意味がない。
 */
export default function middleware(
	request: Parameters<typeof withClerk>[0],
	event: Parameters<typeof withClerk>[1],
) {
	const target = legacyRedirectTarget(request.url);
	if (target) {
		return NextResponse.redirect(target, 308);
	}
	return withClerk(request, event);
}

export const config = {
	matcher: [
		// Skip Next.js internals and static files
		"/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
		// Always run for API routes
		"/(api|trpc)(.*)",
	],
};
