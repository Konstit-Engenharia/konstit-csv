import { join } from 'node:path';
import { csv } from '../src/index.ts';

const orders = join(import.meta.dir, 'orders.csv');

// Clean the customer and city with the same chain. Convert the decimal comma in the amount.
const cleanText = csv.transform().trim().replace(/\s+/, ' ');
for await (
  const batch of csv.rows(orders, {
    skipRows: 1,
    columns: [0, 1, 2],
    transform: [cleanText.on(0, 1), csv.column(2).replace(',', '.')],
  })
) {
  for (const [customer, city, amount,] of batch) {
    console.log(`${customer} | ${city} | ${amount}`);
  }
}
// Ana Silva | São Paulo | 12.50
// José Lima | Vitória | 9.90

// In SP-1042, the named capture "state" is SP and the second capture is 1042.
const orderLabel = csv.column(3).replace(/^(?<state>[A-Z]{2})-(\d+)$/, 'Order $2 ($<state>)');
for await (
  const batch of csv.rows(orders, {
    skipRows: 1,
    columns: [3],
    transform: [orderLabel],
  })
) {
  for (const [label,] of batch) {
    console.log(label);
  }
}
// Order 1042 (SP)
// Order 2087 (ES)
