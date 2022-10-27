const axios = require('axios');
const Web3 = require('web3');

const { ethers } = require('ethers');
require('dotenv').config();
const { API_KEY_ALCHEMY, API_KEY_COINMARKETCAP, PRIVATE_KEY, ORACLE_CONTRACT_ADDRESS } = process.env;

const web3Alchemy = new Web3(`wss://eth-goerli.g.alchemy.com/v2/${API_KEY_ALCHEMY}`);
const oracleContractAbi = [{"anonymous":false,"inputs":[{"indexed":false,"internalType":"string","name":"ticker","type":"string"}],"name":"MyEvent","type":"event"},{"inputs":[],"name":"createPriceRequest","outputs":[],"stateMutability":"nonpayable","type":"function"},{"inputs":[{"internalType":"uint256","name":"","type":"uint256"}],"name":"prices","outputs":[{"internalType":"string","name":"ticker","type":"string"},{"internalType":"uint256","name":"unixTimestamp","type":"uint256"},{"internalType":"string","name":"lastTradedPrice","type":"string"}],"stateMutability":"view","type":"function"},{"inputs":[],"name":"pricesCount","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function"},{"inputs":[{"internalType":"string","name":"_ticker","type":"string"},{"internalType":"uint256","name":"_unixTimestamp","type":"uint256"},{"internalType":"string","name":"_lastTradedPrice","type":"string"}],"name":"storePriceResponse","outputs":[],"stateMutability":"nonpayable","type":"function"}];

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

(async () => {
    await web3Alchemy.eth.subscribe('logs', {
        address: ORACLE_CONTRACT_ADDRESS
    }).on('connected', subId => {
        console.log('Connected');
    }).on('data', async log => {
        const params = web3Alchemy.eth.abi.decodeParameters([
            {
                type: 'string',
                name: 'ticker'
            }
        ], log.data);

        // Get price
        const lastTradedPriceNum = await getLatestQuote(params.ticker);

        // Send price to oracle contract
        const web3Provider = `https://eth-goerli.g.alchemy.com/v2/${API_KEY_ALCHEMY}`;
        const alchemyProvider = new ethers.providers.AlchemyProvider(network="goerli", API_KEY_ALCHEMY);
        const signer = new ethers.Wallet(PRIVATE_KEY, alchemyProvider);
        const contract = new ethers.Contract(ORACLE_CONTRACT_ADDRESS, oracleContractAbi, signer);
        const unixTimestamp = Math.floor(Date.now() / 1000);
        const lastTradedPriceTruncated = lastTradedPriceNum.toFixed(4);
        try {
            const tx = await contract.functions.storePriceResponse(params.ticker, unixTimestamp, lastTradedPriceTruncated.toString());
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
    });
})();
