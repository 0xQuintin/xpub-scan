// Here, the raw data is fetched from default (i.e., free of charge) providers:
//  - balance,
//  - total spent and received, and
//  - operations
// per address

import { getJSON, toAccountUnit } from "../helpers";
import { configuration, ETH_FIXED_PRECISION } from "../configuration/settings";
import { Address } from "../models/address";
import { Transaction } from "../models/transaction";
import { Operation } from "../models/operation";
import { currencies } from "../configuration/currencies";

import BigNumber from "bignumber.js";
import { format } from "date-fns";

// ┏━━━━━━━━━━━━━━━━━━━━┓
// ┃ DEFAULT PROVIDER   ┃
// ┃ Bitcoin & Litecoin ┃
// ┗━━━━━━━━━━━━━━━━━━━━┛

// structure of the responses from the default API
interface RawTransaction {
  txid: string;
  block_no: number;
  confirmations: number;
  time: number;
  incoming: {
    value: string;
    inputs: {
      address: string;
    }[];
  };
  outgoing: {
    value: string;
    outputs: {
      address: string;
      value: string;
    }[];
  };
}

/**
 * fetch the structured basic stats related to an address
 * its balance, funded and spend sums and counts
 * @param address the address being analyzed
 */
async function getStats(address: Address) {
  // important: coin name is required to be upper case for default provider
  let coin = configuration.currency.symbol.toUpperCase();

  if (coin === currencies.bch.symbol) {
    return getBchStats(address);
  }

  if (coin === currencies.eth.symbol) {
    return getAccountBasedStats(address);
  }

  if (coin === currencies.btc.symbol.toUpperCase() && configuration.testnet) {
    // Bitcoin Testnet: "BTCTEST"
    // see: https://sochain.com/api#networks-supported
    coin = coin.concat("TEST");
  }

  const url = configuration.externalProviderURL
    .replace("{currency}", coin)
    .replace("{address}", address.toString());

  const res = await getJSON<any>(url);

  // TODO: check potential errors here (API returning invalid data...)
  const fundedSum = res.data.received_value;
  const balance = res.data.balance;
  const spentSum = fundedSum - balance;

  address.setStats(res.data.total_txs, fundedSum, spentSum);
  address.setBalance(balance);

  address.setRawTransactions(res.data.txs);
}

/**
 * get all structured transactions related to an address
 * @param address the address being analyzed
 */
function getTransactions(address: Address) {
  // Because the general default API is not compatible with Bitcoin Cash,
  // these transactions have to be specifically handled
  if (configuration.currency.symbol === currencies.bch.symbol) {
    return getBitcoinCashTransactions(address);
  }

  if (configuration.currency.symbol === currencies.eth.symbol) {
    return getAccountBasedTransactions(address);
  }

  // 1. get raw transactions
  const rawTransactions = address.getRawTransactions();

  // 2. parse raw transactions
  const transactions: Array<Transaction> = [];

  rawTransactions.forEach((tx: RawTransaction) => {
    const ins: Array<Operation> = [];
    const outs: Array<Operation> = [];

    if (typeof tx.incoming !== "undefined") {
      tx.incoming.inputs.forEach((txin) => {
        const op = new Operation(String(tx.time), tx.incoming.value);
        op.setAddress(txin.address);
        op.setTxid(tx.txid);
        op.setOperationType("Received");

        ins.push(op);
      });
    }

    if (typeof tx.outgoing !== "undefined") {
      tx.outgoing.outputs.forEach((txout) => {
        const op = new Operation(String(tx.time), txout.value);
        op.setAddress(txout.address);
        op.setTxid(tx.txid);
        op.setOperationType("Sent");

        outs.push(op);
      });
    }

    transactions.push(
      new Transaction(
        tx.block_no,
        format(new Date(tx.time * 1000), "yyyy-MM-dd HH:mm:ss"), // unix time to readable format
        tx.txid,
        ins,
        outs,
      ),
    );
  });

  address.setTransactions(transactions);
}

// ┏━━━━━━━━━━━━━━┓
// ┃ BCH PROVIDER ┃
// ┃ Bitcoin Cash ┃
// ┗━━━━━━━━━━━━━━┛

// structure of the responses from the BCH API
interface BchRawTransaction {
  txid: string;
  blockheight: number;
  confirmations: number;
  time: number;
  vin: {
    value: string;
    addr: string;
  }[];
  vout: {
    value: string;
    scriptPubKey: {
      addresses: Array<string>;
    };
  }[];
}

/**
 * fetch the structured basic stats related to a Bitcoin Cash address
 * its balance, funded and spend sums and counts
 * @param address the address being analyzed
 */
async function getBchStats(address: Address) {
  const urlStats = configuration.externalProviderURL
    .replace("{type}", "details")
    .replace("{address}", address.asCashAddress()!);

  const res = await getJSON<any>(urlStats);

  // TODO: check potential errors here (API returning invalid data...)
  const fundedSum = res.totalReceived;
  const balance = res.balance;
  const spentSum = res.totalSent;

  address.setStats(res.txApperances, fundedSum, spentSum);
  address.setBalance(balance);

  const urlTxs = configuration.externalProviderURL
    .replace("{type}", "transactions")
    .replace("{address}", address.asCashAddress()!);

  const payloads = [];
  let totalPages = 1;

  for (let i = 0; i < totalPages; i++) {
    const response = await getJSON<any>(
      urlTxs.concat("?page=").concat(i.toString()),
    );
    totalPages = response.pagesTotal;
    payloads.push(response.txs);
  }

  // flatten the payloads
  const rawTransactions = [].concat(...payloads);

  address.setRawTransactions(rawTransactions);
}

/**
 * get all structured transactions related to a Bitcoin Cash address
 * @param address the address being analyzed
 */
function getBitcoinCashTransactions(address: Address) {
  // 1. get raw transactions
  const rawTransactions = address.getRawTransactions();

  // 2. parse raw transactions
  const transactions: Array<Transaction> = [];

  rawTransactions.forEach((tx: BchRawTransaction) => {
    const ins: Array<Operation> = [];
    const outs: Array<Operation> = [];
    let amount = new BigNumber(0);
    let processIn = false;
    let processOut = false;

    // 1. Detect operation type
    for (const txin of tx.vin) {
      if (txin.addr.includes(address.toString())) {
        processOut = true;
        break;
      }
    }

    for (const txout of tx.vout) {
      if (typeof txout.scriptPubKey.addresses === "undefined") {
        continue;
      }
      for (const outAddress of txout.scriptPubKey.addresses) {
        if (outAddress.includes(address.toString())) {
          // when IN op, amount corresponds to txout
          amount = new BigNumber(txout.value);
          processIn = true;
          break;
        }
      }
    }

    if (processIn) {
      tx.vin.forEach((txin) => {
        const op = new Operation(String(tx.time), amount);
        op.setAddress(txin.addr);
        op.setTxid(tx.txid);
        op.setOperationType("Received");

        ins.push(op);
      });
    }

    if (processOut) {
      tx.vout.forEach((txout) => {
        if (parseFloat(txout.value) === 0) {
          return;
        }
        const op = new Operation(String(tx.time), txout.value);
        op.setAddress(txout.scriptPubKey.addresses[0]);
        op.setTxid(tx.txid);
        op.setOperationType("Sent");

        outs.push(op);
      });
    }

    transactions.push(
      new Transaction(
        tx.blockheight,
        format(new Date(tx.time * 1000), "yyyy-MM-dd HH:mm:ss"), // unix time to readable format
        tx.txid,
        ins,
        outs,
      ),
    );
  });

  address.setTransactions(transactions);
}

// ┏━━━━━━━━━━━━━━┓
// ┃ ETH PROVIDER ┃
// ┃ Ethereum     ┃
// ┗━━━━━━━━━━━━━━┛

// structure of the responses from the ETH API
interface EthRawTransaction {
  tx_hash: string;
  block_height: number;
  value: number;
  tx_input_n: number;
  tx_output_n: number;
  confirmed: string;
  total: number;
}

/**
 * fetch the structured basic stats related to an Ethereum address
 * its balance, funded and spend sums and counts
 * @param address the address being analyzed
 */
async function getAccountBasedStats(address: Address) {
  const url = configuration.externalProviderURL
    .replace("{type}", "addrs")
    .replace("{item}", address.toString());

  const res = await getJSON<any>(url);

  // eslint-disable-next-line  @typescript-eslint/no-explicit-any
  const removeScientificNotation = (value: any) =>
    value.toLocaleString("fullwide", { useGrouping: false });

  const fundedSum = toAccountUnit(
    new BigNumber(removeScientificNotation(res.total_received)),
  );

  const balance = toAccountUnit(
    new BigNumber(removeScientificNotation(res.balance)),
  );

  const spentSum = toAccountUnit(
    new BigNumber(removeScientificNotation(res.total_sent)),
  );

  address.setStats(res.n_tx, fundedSum, spentSum);
  address.setBalance(balance);

  // additional request to get the fees
  for (const txref of res.txrefs) {
    // if not a Sent transaction, skip
    if (txref.tx_output_n !== -1) {
      continue;
    }

    const urlTxs = configuration.externalProviderURL
      .replace("{type}", "txs")
      .replace("{item}", txref.tx_hash);

    const resTxs = await getJSON<any>(urlTxs);
    txref.total = resTxs.total;
  }

  address.setRawTransactions(res.txrefs);
}

/**
 * get all structured transactions related to an account-based address (generally Ethereum)
 * @param address the address being analyzed
 */
function getAccountBasedTransactions(address: Address) {
  // 1. get raw transactions
  const rawTransactions = address.getRawTransactions();

  // 2. parse raw transactions
  const transactions: Array<Transaction> = [];

  rawTransactions.forEach((tx: EthRawTransaction) => {
    const ins: Array<Operation> = [];
    const outs: Array<Operation> = [];

    const isRecipient = tx.tx_input_n === -1;
    const isSender = tx.tx_output_n === -1;

    let amount = tx.value;

    if (isSender) {
      amount = tx.total;
    }

    amount /= configuration.currency.precision;

    const op = new Operation(
      String(tx.confirmed),
      amount.toFixed(ETH_FIXED_PRECISION), // ETH: use fixed-point notation
    );

    const txHash = "0x".concat(tx.tx_hash);

    op.setAddress(address.toString());
    op.setTxid(txHash);
    op.setBlockNumber(tx.block_height);

    if (isRecipient) {
      op.setOperationType("Received");
      address.addFundedOperation(op);
      ins.push(op);
    } else if (isSender) {
      op.setOperationType("Sent");
      address.addSentOperation(op);
      outs.push(op);
    }

    transactions.push(
      new Transaction(
        tx.block_height,
        format(new Date(tx.confirmed), "yyyy-MM-dd'T'HH:mm:ss'Z'"),
        txHash,
        ins,
        outs,
      ),
    );
  });

  address.setTransactions(transactions);
}

export {
  getStats,
  getTransactions,
  getBitcoinCashTransactions,
  getAccountBasedTransactions,
};
