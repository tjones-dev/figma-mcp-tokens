# figma-mcp-tokens Glossary

Terms for how Figma variable collections are organized and turned into design tokens by this tool.

## Terminology

**Tier collection**:
One of several Figma variable collections that hold the same variables but different modes, because one logical collection needs more modes than Figma allows per collection (for example `Element T1` with fire and water, `Element T2` with electric and strength).
_Avoid_: tier mode, variant collection

**Router collection**:
A Figma variable collection whose modes each pick one tier collection, and whose variables alias into it.
_Avoid_: switcher, proxy collection

**Merged collection**:
The single token group, configured under `merge`, that replaces a set of tier collections in `tokens.json` and the outputs.
_Avoid_: combined collection, union collection
