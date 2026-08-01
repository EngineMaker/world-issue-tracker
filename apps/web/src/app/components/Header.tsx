"use client";

import { SignedIn, SignedOut, SignInButton, UserButton } from "@clerk/nextjs";
import Link from "next/link";

export function Header() {
	return (
		<header
			style={{
				display: "flex",
				justifyContent: "space-between",
				alignItems: "center",
				padding: "1rem",
				borderBottom: "1px solid #eee",
			}}
		>
			<h1 style={{ margin: 0, fontSize: "1.2rem" }}>
				<Link href="/">World Issue Tracker</Link>
			</h1>
			<nav style={{ display: "flex", gap: "1rem", alignItems: "center" }}>
				<Link href="/issues/new">Issue を起票</Link>
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
