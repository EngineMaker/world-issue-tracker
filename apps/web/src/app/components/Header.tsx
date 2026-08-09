"use client";

import { SignedIn, SignedOut, SignInButton, UserButton } from "@clerk/nextjs";
import {
	DEFAULT_LOCALE,
	getUiMessages,
	type Locale,
} from "@world-issue-tracker/shared";
import Link from "next/link";
import { LocaleSwitcher } from "./LocaleSwitcher";

export function Header({ locale = DEFAULT_LOCALE }: { locale?: Locale }) {
	const messages = getUiMessages(locale);

	return (
		<header className="site-header">
			<h1 className="site-header-title">
				<Link href="/">{messages.common.siteTitle}</Link>
			</h1>
			<nav className="site-header-nav">
				{/*
				  言語の切り替え（Issue #82）。全ページに出るヘッダに置く。
				  読めない言語で表示されている人が、探さずに見つけられる場所が要る
				*/}
				<LocaleSwitcher locale={locale} />
				<Link href="/issues/new">{messages.header.newIssue}</Link>
				<SignedIn>
					{/*
					  自分の Issue へ戻る導線（Issue #68）。サインイン中だけ出す。
					  未サインインで押しても中身が無く、サインインを促すだけの
					  画面に飛ばすことになるため。
					*/}
					<Link href="/my-issues">{messages.header.myIssues}</Link>
				</SignedIn>
				<SignedOut>
					<SignInButton mode="modal">
						<button type="button">{messages.header.signIn}</button>
					</SignInButton>
				</SignedOut>
				<SignedIn>
					<UserButton />
				</SignedIn>
			</nav>
		</header>
	);
}
