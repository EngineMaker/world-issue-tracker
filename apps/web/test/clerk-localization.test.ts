/**
 * Clerk のサインインモーダルのタイトルの誤字（#154）を止めるテスト。
 *
 * 既定では Clerk はタイトルに Dashboard の Application name を差し込むが、
 * そこが "World Issu Tracker" と誤っていた。値は Dashboard 側にあって
 * コードから直せないため、`localization` でタイトルを上書きしている。
 *
 * ここで見るのは「上書きに使う文字列が、アプリの正式名称（shared の
 * `siteTitle`）と一致し、誤字を含まないこと」。名称の綴りは `siteTitle` を
 * single source of truth にしているので、そことの一致を両ロケールで確かめる。
 *
 * `title` と `titleCombined` の両方を見る。Clerk の結合フロー（サインインと
 * サインアップが 1 枚のカード）が無効なら `title`、有効なら `titleCombined`
 * が描画に使われるため、どちらから出ても誤字が無いことを保証する。
 */

import { describe, expect, it } from "bun:test";
import { getUiMessages, Locale } from "@world-issue-tracker/shared";
import { buildClerkLocalization } from "../src/lib/clerk-localization";

const TITLE_KEYS = ["title", "titleCombined"] as const;

describe("buildClerkLocalization", () => {
	for (const locale of Locale.options) {
		const { siteTitle } = getUiMessages(locale).common;
		const start = buildClerkLocalization(locale).signIn?.start;

		for (const key of TITLE_KEYS) {
			it(`${locale}: サインインの ${key} に正式名称を差し込む`, () => {
				// siteTitle（= "World Issue Tracker"）を single source of truth に
				// しているので、そこと綴りが一致していること
				expect(start?.[key]).toBe(`Sign in to ${siteTitle}`);
				expect(start?.[key]).toContain("World Issue Tracker");
			});

			it(`${locale}: ${key} が誤字 "World Issu Tracker" を含まない`, () => {
				// #154 の誤字。"Issue" の "e" が欠けた綴りが混じっていないこと。
				// 単語境界で見て "Issue"（正）を "Issu"（誤）と取り違えないようにする
				expect(start?.[key]).not.toMatch(/World Issu\b/);
			});
		}
	}
});
