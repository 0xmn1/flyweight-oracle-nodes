const axios = require('axios');
const Web3 = require('web3');
const fs = require('fs');
const path = require('path');

const { ethers } = require('ethers');
require('dotenv').config();
const { API_KEY_ALCHEMY, API_KEY_COINMARKETCAP, PRIVATE_KEY, ORACLE_CONTRACT_ADDRESS } = process.env;

const web3Alchemy = new Web3(`wss://eth-goerli.g.alchemy.com/v2/${API_KEY_ALCHEMY}`);
const oracleContractAbiPath = path.resolve(__dirname, 'oracle-smart-contract-abi.json');
const oracleContractAbi = JSON.parse(fs.readFileSync(oracleContractAbiPath, 'utf8'));

const getLatestQuote = async symbol => {
    try {
        const res = await axios.get(`https://pro-api.coinmarketcap.com/v2/cryptocurrency/quotes/latest?symbol=${symbol}`, {
            headers: {
                'X-CMC_PRO_API_KEY': API_KEY_COINMARKETCAP
            }
        });

        const price = res?.data?.data[symbol][0]?.quote?.USD?.price;
        if (!price) {
            const errorMsg = 'Failed to extract price from coinmarketcap api response';
            throw errorMsg;
        }

        return price;
    } catch(ex) {
        console.error(ex);
    }
};

const writePricesCache = async prices => {
    const pricesPath = path.resolve(__dirname, 'prices-cache.json');
    fs.writeFileSync(pricesPath, JSON.stringify(prices));
};

const cacheNewPrice = async (prices, ticker) => {
    // Get price
    const lastTradedPriceNum = await getLatestQuote(ticker);

    // Send price to oracle contract
    const web3Provider = `https://eth-goerli.g.alchemy.com/v2/${API_KEY_ALCHEMY}`;
    const alchemyProvider = new ethers.providers.AlchemyProvider(network="goerli", API_KEY_ALCHEMY);
    const signer = new ethers.Wallet(PRIVATE_KEY, alchemyProvider);
    const contract = new ethers.Contract(ORACLE_CONTRACT_ADDRESS, oracleContractAbi, signer);
    const unixTimestamp = Math.floor(Date.now() / 1000);

    prices.push({
        token0: ticker,
        token1: ticker,
        price: lastTradedPriceNum.toString(),
        unixTimestamp: unixTimestamp.toString()
    });

    await writePricesCache(prices);
};

const tryUpdateContractState = async (prices, triggeredOrderIds) => {
    try {
        const tx = await contract.functions.storePricesAndProcessTriggeredOrderIds(prices, triggeredOrderIds);
        console.log('Sending new data to oracle contract...');
        const txReceipt = await tx.wait();
        if (txReceipt.status !== 1) {
            throw txReceipt;
        }

        console.log('Sent.');
        return true;
    } catch (err) {
        console.error('Failed to update contract state:');
        console.error(err);
        return false;
    }
};

const checkOrders = async prices => {
    const web3Provider = `https://eth-goerli.g.alchemy.com/v2/${API_KEY_ALCHEMY}`;
    const alchemyProvider = new ethers.providers.AlchemyProvider(network="goerli", API_KEY_ALCHEMY);
    const signer = new ethers.Wallet(PRIVATE_KEY, alchemyProvider);
    const contract = new ethers.Contract(ORACLE_CONTRACT_ADDRESS, oracleContractAbi, signer);

    // 1. read contract state (orders+prices)
    const ordersCount = await contract.functions.ordersCount();

    // 2. for ea order, note down result
    const triggeredOrderIds = [];
    for (let i = 0; i < ordersCount; i++) {
        const order = await contract.functions.orders(i);
        const tokenPrices = prices.filter(p => p.token0 === order.token0);
        if (!tokenPrices.length) {
            // Dont trigger order if no price data available
            continue;
        }

        const latestTokenPrice = tokenPrices[tokenPrices.length - 1]
        let isOrderTriggered = false;
        switch (order.direction) {
            case 'BELOW':
                isOrderTriggered = latestTokenPrice < order.tokenInTriggerPrice;
                break;
            case 'EQUAL':
                isOrderTriggered = latestTokenPrice === order.tokenInTriggerPrice;
                break;
            case 'ABOVE':
                isOrderTriggered = latestTokenPrice > order.tokenInTriggerPrice;
                break;
        }

        if (isOrderTriggered) {
            triggeredOrderIds.push(order.id);
        }
    }

    // 3. call contract to store results
    if (await tryUpdateContractState(prices, triggeredOrderIds)) {
        prices = [];
        await writePricesCache(prices);
    }
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
    await web3Alchemy.eth.subscribe('logs', {
        address: ORACLE_CONTRACT_ADDRESS
    }).on('connected', subId => {
        console.log('Connected');
    }).on('data', async log => {
        // dm chkpt
    });

    // Periodically send new price to contract
    const prices = [];
    while (true) {
        await cacheNewPrice(prices, 'UNI');
        await checkOrders(prices);
        const sleepMs = 60000;
        console.log(`Sleeping for ${sleepMs}ms`)
        await sleep(sleepMs);
    }
})();
