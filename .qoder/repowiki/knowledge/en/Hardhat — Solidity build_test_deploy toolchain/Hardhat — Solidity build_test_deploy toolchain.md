---
kind: external_dependency
name: Hardhat — Solidity build/test/deploy toolchain
slug: hardhat
category: external_dependency
category_hints:
    - framework_behavior
scope:
    - '**'
source_files:
    - contracts/package.json
---

The `@smf/contracts` workspace uses Hardhat (`@nomicfoundation/hardhat-toolbox`) as the Solidity compilation, testing, and deployment framework. Scripts exposed: `compile`, `test`, `node`, `deploy`, and `deploy:amoy`. The contracts directory currently contains only the package manifest; Solidity sources and Hardhat config are expected alongside it per the standard layout.