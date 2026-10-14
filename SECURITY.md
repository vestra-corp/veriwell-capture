# Security Policy

## Supported versions

Security fixes go into the latest release on `main`.

| Version | Supported |
| ------- | --------- |
| 0.1.x   | Yes       |
| older   | No        |

## Reporting a vulnerability

Please do **not** open a public issue, discussion or pull request for security problems.

Report privately instead:

- **Preferred:** use GitHub's private vulnerability reporting ("Report a vulnerability" under the repository's **Security** tab).
- **Email:** abuse@vestracorp.com, with "veriwell-capture security" in the subject.

Please include the affected version or commit, steps to reproduce, the impact you expect and any proof of concept. We aim to acknowledge reports within 3 business days and will keep you updated while we work on a fix. Tell us if you would like to be credited.

## Scope

In scope: code in this repository, for example a way to make the library leak captured frames, run injected code, or crash a page from crafted input to the MRZ parser.

Out of scope: the fact that client-side checks can be bypassed. This library only guides users to take good photos. It is not a security boundary, and the README says so; the real verification decision belongs on a server. Issues in third-party dependencies (such as MediaPipe) should be reported upstream, though we are glad to hear about them too.
