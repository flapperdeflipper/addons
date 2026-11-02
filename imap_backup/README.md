# IMAP Backup

A small IMAP server (Dovecot) to back up mail into. Add it as an account in
Apple Mail (or any IMAP client) and copy mailboxes from your other accounts
onto it. Mail is stored as plain Maildir under `/share`, so whatever backs up
`/share` backs up your mail too.

See [DOCS.md](DOCS.md) for setup.
