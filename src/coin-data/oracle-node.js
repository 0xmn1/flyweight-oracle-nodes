const axios = require('axios');
const Web3 = require('web3');

const { ethers } = require('ethers');
require('dotenv').config();
const { API_KEY_ALCHEMY, API_KEY_COINMARKETCAP, PRIVATE_KEY, ORACLE_CONTRACT_ADDRESS } = process.env;

const web3Alchemy = new Web3(`wss://eth-goerli.g.alchemy.com/v2/${API_KEY_ALCHEMY}`);
const oracleContractAbi = [{"anonymous":false,"inputs":[],"name":"GetNewOrderResults","type":"event"},{"inputs":[{"internalType":"uint256","name":"","type":"uint256"}],"name":"orders","outputs":[{"internalType":"uint256","name":"id","type":"uint256"},{"internalType":"enum Flyweight.OrderState","name":"orderState","type":"uint8"},{"internalType":"string","name":"tokenIn","type":"string"},{"internalType":"string","name":"tokenOut","type":"string"},{"internalType":"string","name":"tokenInTriggerPrice","type":"string"},{"internalType":"enum Flyweight.OrderTriggerDirection","name":"direction","type":"uint8"},{"internalType":"uint256","name":"tokenInAmount","type":"uint256"}],"stateMutability":"view","type":"function"},{"inputs":[],"name":"ordersCount","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function"},{"inputs":[{"internalType":"uint256","name":"","type":"uint256"}],"name":"prices","outputs":[{"internalType":"string","name":"token0","type":"string"},{"internalType":"string","name":"token1","type":"string"},{"internalType":"string","name":"unixTimestamp","type":"string"},{"internalType":"string","name":"price","type":"string"}],"stateMutability":"view","type":"function"},{"inputs":[],"name":"pricesCount","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function"},{"inputs":[{"internalType":"uint256[]","name":"triggeredOrderIds","type":"uint256[]"}],"name":"storeAndProcessOrderResults","outputs":[],"stateMutability":"nonpayable","type":"function"},{"inputs":[{"internalType":"string","name":"token0","type":"string"},{"internalType":"string","name":"token1","type":"string"},{"internalType":"string","name":"unixTimestamp","type":"string"},{"internalType":"string","name":"price","type":"string"}],"name":"storePriceAndGetNewOrderResults","outputs":[],"stateMutability":"nonpayable","type":"function"}];

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

const sendNewPriceToContract = async ticker => {
    // Get price
    const lastTradedPriceNum = await getLatestQuote(ticker);

    // Send price to oracle contract
    const web3Provider = `https://eth-goerli.g.alchemy.com/v2/${API_KEY_ALCHEMY}`;
    const alchemyProvider = new ethers.providers.AlchemyProvider(network="goerli", API_KEY_ALCHEMY);
    const signer = new ethers.Wallet(PRIVATE_KEY, alchemyProvider);
    const contract = new ethers.Contract(ORACLE_CONTRACT_ADDRESS, oracleContractAbi, signer);
    const unixTimestamp = Math.floor(Date.now() / 1000);

    const lastTradedPriceTruncated = lastTradedPriceNum.toFixed(4);
    try {
        const tx = await contract.functions.storePriceAndGetNewOrderResults(ticker, ticker, unixTimestamp.toString(), lastTradedPriceTruncated.toString());
        console.log('Sending price data to oracle contract...');
        const txReceipt = await tx.wait();

        if (txReceipt.status !== 1) {
            throw 'Failed to submit transaction (to send price data to oracle contract)';
        }

        console.log('Successfully sent price data to oracle contract');
    } catch (err) {
        console.error(err);
        throw err;
    }
};

const getNewOrderResults = async data => {
    const web3Provider = `https://eth-goerli.g.alchemy.com/v2/${API_KEY_ALCHEMY}`;
    const alchemyProvider = new ethers.providers.AlchemyProvider(network="goerli", API_KEY_ALCHEMY);
    const signer = new ethers.Wallet(PRIVATE_KEY, alchemyProvider);
    const contract = new ethers.Contract(ORACLE_CONTRACT_ADDRESS, oracleContractAbi, signer);

    // 1. read contract state (orders+prices)
    const ordersCount = await contract.functions.ordersCount();
    const pricesCount = await contract.functions.pricesCount();

    // 2. for ea order, note down result
    const triggeredOrderIds = [];
    for (let i = 0; i < ordersCount; i++) {
        const order = await contract.functions.orders(i);
        const latestPrice = await contract.functions.prices(pricesCount - 1);
        switch (order.direction) {
            case 'BELOW':
                if (latestPrice < order.tokenInTriggerPrice) {
                    triggeredOrderIds.push(order.id);
                }
                break;
            case 'EQUAL':
                if (latestPrice === order.tokenInTriggerPrice) {
                    triggeredOrderIds.push(order.id);
                }
                break;
            case 'ABOVE':
                if (latestPrice > order.tokenInTriggerPrice) {
                    triggeredOrderIds.push(order.id);
                }
                break;
        }
    }

    // 3. call contract to store results
    await contract.functions.storeAndProcessOrderResults(triggeredOrderIds);
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
    await web3Alchemy.eth.subscribe('logs', {
        address: ORACLE_CONTRACT_ADDRESS
    }).on('connected', subId => {
        console.log('Connected');
    }).on('data', async log => {
       await getNewOrderResults(log.data);
    });

    // Periodically send new price to contract
    while (true) {
        await sendNewPriceToContract('UNI');

        process.exit(); // dm
        await sleep(60000);
    }
})();
