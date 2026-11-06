# Security Policy

ci-wizard reads a repository's GitHub Actions history and workflow files with a token it is
given. It never writes to the repository, and the token never leaves the process except as the
`Authorization` header of read requests to the GitHub API: api.github.com, or on GitHub
Enterprise Server and GHE.com the https API that `GITHUB_API_URL` names. Text from the audited
repository (workflow, job and step names, file names, expressions) is rendered as text in every
report, never as markup or terminal control codes; each request has a deadline and a size cap.

## Reporting a vulnerability

Please **do not open a public issue** for security reports.

- **Preferred:** [GitHub private vulnerability reporting](https://github.com/askalf/ci-wizard/security/advisories/new),
  which creates a private advisory visible only to maintainers.
- **Email:** support@askalf.org with `ci-wizard security` in the subject.

You will get an acknowledgement within 72 hours. Please include a minimal reproduction where
possible.

## Supported versions

ci-wizard is pre-1.0: only the latest release receives security fixes; there are no maintenance
branches.

## In scope

- **Token exposure:** the token printed, logged, written to a report, or sent anywhere other
  than the GitHub API.
- **Writes:** any request other than a GET, or any change to the audited repository.
- **Injection:** a workflow name, step name, branch name or workflow file that makes the report,
  the HTML page or the action's workflow commands do something other than display text (markup
  or script in the HTML page, a forged `::command::` line, a broken markdown table that hides a
  finding).
- **Crash on hostile input:** a workflow file or API answer that makes the audit hang or throw
  past its documented errors.

Out of scope: a finding that is wrong or a threshold that does not fit a repository. Those are
bugs; please open an issue.
