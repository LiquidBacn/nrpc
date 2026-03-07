# Agent Rules

- Use early returns for guard clauses only. When branching on a top-level mutually exclusive condition, such as a message kind or type, prefer a single `if / else if / else` chain or a `switch` instead of separate `if (...) { ... return; }` blocks.
