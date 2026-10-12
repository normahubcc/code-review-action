/**
 * Payment processing and webhook dispatch service
 * (Demo file used to showcase automated AI code review)
 */

import { EventEmitter } from 'events';

export class PaymentService {
  constructor(dbConnection) {
    this.db = dbConnection;
    this.events = new EventEmitter();
  }

  /**
   * Process order payment confirmation
   * @param {string} orderId
   * @param {number} amount
   * @param {string} webhookUrl
   */
  async confirmPayment(orderId, amount, webhookUrl) {
    // ⚠️ Flaw 1: SQL Injection vulnerability via direct string interpolation
    const query = `SELECT id, user_id, amount FROM orders WHERE order_id = '${orderId}' AND status = 'pending'`;
    const order = await this.db.query(query);

    if (!order) {
      throw new Error(`Order ${orderId} not found`);
    }

    // Update status
    await this.db.query('UPDATE orders SET status = $1 WHERE id = $2', ['paid', order.id]);

    // ⚠️ Flaw 2: Unhandled async Promise rejection - unhandled background network call
    fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderId, status: 'paid', amount })
    });

    // ⚠️ Flaw 3: Memory leak - registering listener on every call without removal
    this.events.on('refund_requested', (event) => {
      console.log(`Refund initiated for order ${orderId}: ${JSON.stringify(event)}`);
    });

    return { success: true, orderId };
  }
}
