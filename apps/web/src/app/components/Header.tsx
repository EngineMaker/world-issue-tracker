"use client";

import { SignedIn, SignedOut, SignInButton, UserButton } from "@clerk/nextjs";
import Link from "next/link";

export function Header() {
	return (
		<header className="site-header">
			<h1 className="site-header-title">
				<Link href="/">World Issue Tracker</Link>
			</h1>
			<nav className="site-header-nav">
				<Link href="/issues/new">Issue を起票</Link>
				<SignedIn>
					{/*
					  自分の Issue へ戻る導線（Issue #68）。サインイン中だけ出す。
					  未サインインで押しても中身が無く、サインインを促すだけの
					  画面に飛ばすことになるため。
					*/}
					<Link href="/my-issues">自分の Issue</Link>
				</SignedIn>
				<SignedOut>
					<SignInButton mode="modal">
						<button type="button">Sign In</button>
					</SignInButton>
				</SignedOut>
				<SignedIn>
					<UserButton />
				</SignedIn>
			</nav>
		</header>
	);
}
