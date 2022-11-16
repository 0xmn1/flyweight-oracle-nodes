const axios = require('axios');
const Web3 = require('web3');
const fs = require('fs');
const path = require('path');
const aws = require('aws-sdk');
const { ethers } = require('ethers');

let API_KEY_COINMARKETCAP = null;
let contract = null;

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
};

const tryUpdateContractState = async (prices, triggeredOrderIds) => {
    try {

        const latestPrices = [];
        for (let i = 0; i < prices.length; i++) {
            const price = prices[i];
            const isLatestPriceMapped = latestPrices.find(lp => lp.symbol.toUpperCase() === price.token0.toUpperCase());
            if (!isLatestPriceMapped) {
                const pricesForSymbol = prices.filter(p => p.token0.toUpperCase() === price.token0.toUpperCase());
                latestPrices.push({
                    symbol: price.token0,
                    price: price.price
                });
            }
        }

        const tx = await contract.functions.storePricesAndProcessTriggeredOrderIds(latestPrices, triggeredOrderIds, {
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
        }
    } else {
        console.log('No orders triggered, skipping contract state update');
    }
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

const runOracleNode = async () => {
    // decrypt .env using aws kms
    let config = null;
    try {
        const kms = new aws.KMS({'region': 'ap-northeast-1'});
        const envSecretsEncryptedPath = path.resolve(__dirname, 'build', 'env-secrets-encrypted.json');
        const params = {
          CiphertextBlob: fs.readFileSync(envSecretsEncryptedPath)
        };

        const data = await kms.decrypt(params).promise();
        config = JSON.parse(data['Plaintext'].toString());
    } catch (Error){
        console.error(Error, Error.stack);
        return {
            statusCode: 500,
            body: JSON.stringify('Sorry, something went wrong'),
        };
    }
    
    const oracleContractAbiPath = path.resolve(__dirname, 'oracle-smart-contract-abi.json');
    const oracleContractAbi = JSON.parse(fs.readFileSync(oracleContractAbiPath, 'utf8'));
    const alchemyProvider = new ethers.providers.AlchemyProvider(network="goerli", config.apiKeyAlchemy);
    const signer = new ethers.Wallet(config.privateKey, alchemyProvider);
    API_KEY_COINMARKETCAP = config.apiKeyCoinMarketCap;
    contract = new ethers.Contract(config.oracleContractAddress, oracleContractAbi, signer);

    console.log('Successfully extracted env secrets');
    
    // Periodically send new price to contract
    const prices = [];
    await cacheNewPrice(prices, 'UNI');
    await checkOrders(prices);

    return {
        statusCode: 200,
        body: `Oracle successfully ran. The fetched prices were: ${JSON.stringify(prices)}`,
    };
};

exports.handler = async (event) => await runOracleNode();
