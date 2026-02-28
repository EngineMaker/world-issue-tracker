import { IssueScope, IssueStatus } from "@world-issue-tracker/shared";

export default function Home() {
	const scopes = IssueScope.options;
	const statuses = IssueStatus.options;

	return (
		<main>
			<h1>World Issue Tracker</h1>
			<p>地球のバグを、みんなで可視化して、みんなで直す</p>

			<section>
				<h2>Issue Scopes</h2>
				<ul>
					{scopes.map((scope) => (
						<li key={scope}>{scope}</li>
					))}
				</ul>
			</section>

			<section>
				<h2>Issue Statuses</h2>
				<ul>
					{statuses.map((status) => (
						<li key={status}>{status}</li>
					))}
				</ul>
			</section>
		</main>
	);
}
