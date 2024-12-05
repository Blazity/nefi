# next-enterprise Feature Manager

This package contains the source code for the Feature Manager CLI, a component of the [`next-enterprise`][next-enterprise] repository.

## Project Design Philosophy

Within the [`next-enterprise`][next-enterprise] repository, our goal is to provide a system that allows effortless modification of the boilerplate's base features. This approach enables modular design without impacting the minimal base boilerplate.

While keeping the CLI as a closed-source product would benefit community building and boilerplate adoption, we also value the advantages of open-source development. To balance these needs, we've structured the project as follows:

1. CLI modules remain open-source in a [separate repository], accessible to the public
2. These modules are integrated into the main repository using [git submodules]
3. The complete package is then bundled and published to the NPM registry

This architecture allows users to contribute to the project by adding or removing integrations while maintaining closed-source control of the core CLI.

## Development Prerequisites

- Bun (used exclusively as package manager)
- Node.js
- Git

[next-enterprise]: https://github.com/Blazity/next-enterprise
[git submodules]: https://git-scm.com/book/en/v2/Git-Tools-Submodules
<!--
TODO: Fill the link with the public repository
-->
[separate repository]: https://github.com/Blazity/
