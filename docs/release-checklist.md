# Release checklist

This checklist is a publication gate, not evidence of a deployment or plugin approval.

- Select the project license explicitly and confirm rights to publish the source. Review dependency and image licenses before distributing a binary image.
- Start with a new repository whose first commit contains only the reviewed public file allowlist. Do not import private project history, backups or a container filesystem.
- Review every staged path, including hidden files, symlinks, binary signatures, archive contents, test fixtures and commit author/committer metadata. Use an intended public name and a verified GitHub noreply address where appropriate.
- Run a local secret/privacy scan and manual review of the exact staged blobs and resulting commit history. Classify deterministic fixtures and public package integrity hashes separately from credentials. Never send private source or credentials to an online scanner.
- Confirm that runtime configuration, secret files, state databases, logs, captured catalogs, callback captures, reports, archives, local dependencies and personal paths are excluded from Git and Docker build context.
- Run `npm run check`, public-example configuration validation and the full Node suite on the supported Node version. Build the canonical Dockerfile locally and confirm that its required test stage passes.
- Run the optional native HA schema and behavior tests in the intended HA version before installing the example. Maintain the fictional public examples separately from private mappings.
- Record the exact initial commit, remote destination, visibility and published file list. Review these before the external write. Do not assume a previously available repository name remains available.
- If migrating a deployment, separately approve changes and verify the legacy service header, encryption namespace, external key, owner, contract mapping, subscription identifiers and state backup. Do not rewrite live identifiers during source publication.
- Before claiming integration, have the actual client call a permitted tool and receive an approved isolated event. Recheck lease refresh and restart behavior in that deployment. Keep raw callback URLs, signing secrets and private payloads out of public evidence.
- If publishing an image, build it from this public tree and official pinned bases. Do not publish an existing private runtime image, volume export or image archive.

No public plugin listing, OAuth server, tenant isolation or universal account-plan support is claimed by this preview.
