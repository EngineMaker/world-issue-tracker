"use client";

import { SignedIn, SignedOut, SignInButton, UserButton } from "@clerk/nextjs";

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
			<h1 style={{ margin: 0, fontSize: "1.2rem" }}>World Issue Tracker</h1>
			<nav>
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
