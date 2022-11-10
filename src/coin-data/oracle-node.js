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

const web3Provider = `https://eth-goerli.g.alchemy.com/v2/${API_KEY_ALCHEMY}`;
const alchemyProvider = new ethers.providers.AlchemyProvider(network="goerli", API_KEY_ALCHEMY);
const signer = new ethers.Wallet(PRIVATE_KEY, alchemyProvider);
const contract = new ethers.Contract(ORACLE_CONTRACT_ADDRESS, oracleContractAbi, signer);

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
        const tx = await contract.functions.storePricesAndProcessTriggeredOrderIds(prices, triggeredOrderIds, {
            gasLimit: 5000000
        });

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
    // 1. read contract state (orders+prices)
    const ordersCount = await contract.functions.ordersCount();

    // 2. for ea order, note down result
    const triggeredOrderIds = [];
    for (let i = 0; i < ordersCount; i++) {
        const order = await contract.functions.orders(i);
        // If order already triggered
        if (order.orderState !== 0) {
            console.log(`Order #${order.id} already triggered, skipping order trigger check`);
            continue;
        }

        const tokenPrices = prices.filter(p => p.token0.toUpperCase() === order.tokenIn.toUpperCase());
        // If no price data
        if (!tokenPrices.length) {
            // Dont trigger order if no price data available
            console.log(`No price data available for order #${order.id}, skipping order trigger check`);
            continue;
        }

        const latestTokenPriceRecord = tokenPrices[tokenPrices.length - 1]
        const latestTokenPrice = parseFloat(latestTokenPriceRecord.price);
        let isOrderTriggered = false;
        console.log(`Checking if order #${order.id} triggered...`);
        switch (order.direction) {
            case 0: // below
                console.log(`${latestTokenPrice} < ${order.tokenInTriggerPrice}?`);
                isOrderTriggered = latestTokenPrice < order.tokenInTriggerPrice;
                break;
            case 1: // equal
                console.log(`${latestTokenPrice} === ${order.tokenInTriggerPrice}?`);
                isOrderTriggered = latestTokenPrice === order.tokenInTriggerPrice;
                break;
            case 2: // above
                console.log(`${latestTokenPrice} > ${order.tokenInTriggerPrice}?`);
                isOrderTriggered = latestTokenPrice > order.tokenInTriggerPrice;
                break;
        }

        if (isOrderTriggered) {
            console.log('Order triggered.')
            triggeredOrderIds.push(order.id);
        } else {
            console.log('Order not triggered.')
        }
    }

    // 3. call contract to store results
    if (triggeredOrderIds.length) {
        console.log(`${triggeredOrderIds.length} orders triggered`);
        if (await tryUpdateContractState(prices, triggeredOrderIds)) {
            prices = [];
            await writePricesCache(prices);
        }
    } else {
        console.log('No orders triggered, skipping contract state update');
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
    
    const pricesCachePath = path.resolve(__dirname, 'prices-cache.json');
    const prices = fs.existsSync(pricesCachePath)
        ? JSON.parse(fs.readFileSync(pricesCachePath))
        : [];

    while (true) {
        await cacheNewPrice(prices, 'UNI');
        await checkOrders(prices);

        // dm un-dm
        //const sleepMs = 60000;
        // dm
        const sleepMs = 600000000;
        console.log(`Sleeping for ${sleepMs}ms`)
        await sleep(sleepMs);
    }
})();
