import { clerkMiddleware } from "@clerk/nextjs/server";
import {
	LEGACY_WEB_ORIGINS,
	PRODUCTION_WEB_ORIGIN,
} from "@world-issue-tracker/shared";

/*
 * `authorizedParties` を明示する（#98）。理由は API 側
 * （`apps/api/src/middleware/clerk.ts`）と同じで、指定しないと同じ root
 * ドメイン配下の別サブドメインが侵害されたときに、そこで作られたセッションが
 * このアプリでも通ってしまう。`emaker.dev` は reactions.emaker.dev と
 * ゾーンを共有しているため、この対策が実際に意味を持つ。
 */
export default clerkMiddleware({
	authorizedParties: [
		"http://localhost:3000",
		PRODUCTION_WEB_ORIGIN,
		...LEGACY_WEB_ORIGINS,
	],
});

export const config = {
	matcher: [
		// Skip Next.js internals and static files
		"/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
		// Always run for API routes
		"/(api|trpc)(.*)",
	],
};
