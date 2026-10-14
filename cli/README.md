# lifeboat-cli

Command line client for Lifeboat: software releases whose hashes, revocations and mirrors live on
Arkiv, so downloads stay verifiable when the project's website is blocked, taken down or hacked.

    npm i -g ./lifeboat-cli-0.1.0.tgz     # one file, no dependencies, Node 22+
    lifeboat fetch lifeboat-cli --publisher 0x8fb633d00b49d851dbff111b0d7c1eec8f9dcea2
    lifeboat verify ./some-file.tgz --publisher 0x...
    lifeboat help

The publisher address is the one thing you trust. Get it from the project's own channels.

Source, docs and threat model: https://github.com/0xmago77/lifeboat (MIT).
Bundled third-party code (viem, @arkiv-network/sdk, @noble/*, @scure/*, abitype, ox) keeps its
own licenses; see the legal comments at the end of lifeboat.mjs.
