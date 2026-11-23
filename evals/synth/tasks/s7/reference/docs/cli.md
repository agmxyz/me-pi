# inv CLI

`inv` keeps products, stock, and orders in one JSON state file: `./inventory.json`, or `$INV_FILE` when set. A command that fails prints `error: <CODE>: <message>` to stderr, exits 1, and leaves the file unchanged. Wrong arguments print the usage and exit 2.

| Command | Does |
|---|---|
| `add <sku> <name> <price> [--reorder <n>]` | Adds a product. SKUs look like `ABC-1234`; prices are dollar amounts (`12.50`). The reorder level defaults to 5 |
| `rename <sku> <name>` | Renames a product |
| `price <sku> <price>` | Changes a product's list price; prints the new and old price |
| `receive <sku> <qty>` | Adds received units to stock |
| `low` | Lists products whose available units are at or below their reorder level |
| `order new <customer>` | Starts a draft order and prints its id (`O-0001`) |
| `order add <id> <sku> <qty>` | Adds units to a draft order at the product's current price |
| `order discount <id> <code>` | Applies a discount code (see `pricing.md`) to a draft order |
| `order reprice <id>` | Sets every line of a draft order to its product's current list price |
| `order place <id>` | Reserves every line's units; fails, reserving nothing, if any line is short |
| `order ship <id>` | Ships a placed order: its units leave stock |
| `order cancel <id>` | Cancels a draft or placed order and releases its reservations |
| `order show <id>` | Prints the order with subtotal, discount, tax, and total |
| `report <name>` | Prints a report; `inv help` lists the names |

Available units are units on hand less units reserved by placed orders.
