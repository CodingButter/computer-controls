# Plugin fixtures

Real, loadable Mastra Code plugins that exist so `../plugins.test.ts` can put
plugins on a machine the hub did not install and watch what the allowlist does
with them.

They are deliberately not mocks. The point of the test is that a plugin sitting
in the operator's registry is genuinely mountable — it exports a plugin object,
it mints tools, the loader can import it — and is nevertheless absent from the
session unless the hub admitted it by name. A stub that could not have loaded
would make every absence assertion vacuous.

`memorease` shares its id with the memory plugin the default allowlist admits.
It stands in for the real one so the test proves admission by name on any
machine, including one where nobody has ever installed it.
