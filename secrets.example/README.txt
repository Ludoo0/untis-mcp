Docker secrets for compose.yaml
===============================

1. Copy this folder (secrets/ is ignored by git and by the Docker build):
     Bash:        cp -r secrets.example secrets
     PowerShell:  Copy-Item -Recurse secrets.example secrets
   (README.txt may stay in secrets/ or be deleted.)

2. Fill the two files in secrets/ – just the value, one line each:
     untis_qr_url   the link of the Untis Mobile QR code:
                    WebUntis → profile → "Freigaben" (sharing) → Untis Mobile → show.
                    Scan the QR code with any QR reader (do NOT use an online service) and copy the text,
                    it looks like untis://setschool?url=…&school=…&user=…&key=…
                    The key works like a password – keep it secret. Creating a new QR code invalidates the old one.
     mcp_api_key    random API key (at least 32 characters) that MCP clients send
                    as "Authorization: Bearer <key>"

   Generate an API key:
     openssl rand -hex 32
   or
     bun -e "console.log(crypto.randomUUID().replaceAll('-','') + crypto.randomUUID().replaceAll('-',''))"

   The placeholder in mcp_api_key is deliberately too short – the server refuses to start until it is replaced.

3. Start:
     docker compose up -d --build

Linux hosts: Compose mounts the secret files with the host's permissions.
The server runs as user "bun" (UID 1000) inside the container – the files must be readable for it:
     chmod 600 secrets/* && sudo chown 1000:1000 secrets/*
(Nothing to do with Docker Desktop on Windows/macOS.)
