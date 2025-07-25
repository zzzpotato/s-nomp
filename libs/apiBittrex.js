import crypto from 'crypto';
import { fetch } from 'undici';

export default class BittrexAPI {
    constructor(key, secret) {
        this.key = key;
        this.secret = secret;
        this.version = '0.1.0';
        this.PUBLIC_API_URL = 'https://api.bittrex.com/v3';
        this.PRIVATE_API_URL = 'https://api.bittrex.com/v3';
        this.USER_AGENT = 'nomp/node-open-mining-portal';
        this.STRICT_SSL = true;
        this.requestCount = 0;
    }

    _getPrivateHeaders(uri, body = '') {
        if (!this.key || !this.secret) {
            throw new Error('Bittrex: API key and secret required for private endpoints');
        }

        const timestamp = Date.now().toString();
        const contentHash = crypto.createHash('sha512').update(body).digest('hex');
        const preSign = [timestamp, uri, 'GET', contentHash].join('');
        const signature = crypto.createHmac('sha512', this.secret).update(preSign).digest('hex');

        return {
            'Api-Key': this.key,
            'Api-Timestamp': timestamp,
            'Api-Content-Hash': contentHash,
            'Api-Signature': signature,
            'Content-Type': 'application/json',
            'User-Agent': this.USER_AGENT
        };
    }

    async _request(method, endpoint, params = {}, isPrivate = false) {
        const url = new URL(endpoint, isPrivate ? this.PRIVATE_API_URL : this.PUBLIC_API_URL);
        
        if (method === 'GET' && Object.keys(params).length > 0) {
            Object.entries(params).forEach(([key, value]) => {
                if (value !== undefined && value !== null) {
                    url.searchParams.append(key, value.toString());
                }
            });
        }

        const options = {
            method,
            headers: {
                'User-Agent': this.USER_AGENT,
                'Content-Type': 'application/json'
            }
        };

        if (isPrivate) {
            const body = method !== 'GET' ? JSON.stringify(params) : '';
            options.headers = { ...options.headers, ...this._getPrivateHeaders(url.toString(), body) };
            if (method !== 'GET') {
                options.body = body;
            }
        }

        try {
            this.requestCount++;
            const response = await fetch(url.toString(), options);
            
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }

            const data = await response.json();
            return data;
        } catch (error) {
            throw new Error(`Bittrex API request failed: ${error.message}`);
        }
    }

    // Helper method to join currencies in Bittrex format
    joinCurrencies(currencyA, currencyB) {
        return `${currencyA}-${currencyB}`;
    }

    // PUBLIC METHODS

    async getMarkets() {
        return this._request('GET', '/markets');
    }

    async getTicker(market = null) {
        const endpoint = market ? `/markets/${market}/ticker` : '/markets/tickers';
        return this._request('GET', endpoint);
    }

    async getMarketSummary(market = null) {
        const endpoint = market ? `/markets/${market}/summary` : '/markets/summaries';
        return this._request('GET', endpoint);
    }

    async getOrderBook(market, depth = 25) {
        const params = { depth };
        return this._request('GET', `/markets/${market}/orderbook`, params);
    }

    async getTradeHistory(market) {
        return this._request('GET', `/markets/${market}/trades`);
    }

    async getCandles(market, candleInterval, options = {}) {
        const params = { candleInterval, ...options };
        return this._request('GET', `/markets/${market}/candles`, params);
    }

    // PRIVATE METHODS

    async getBalances() {
        return this._request('GET', '/balances', {}, true);
    }

    async getBalance(currency) {
        return this._request('GET', `/balances/${currency}`, {}, true);
    }

    async getOrders(options = {}) {
        return this._request('GET', '/orders/open', options, true);
    }

    async getOrderHistory(options = {}) {
        return this._request('GET', '/orders/closed', options, true);
    }

    async getOrder(orderId) {
        return this._request('GET', `/orders/${orderId}`, {}, true);
    }

    async cancelOrder(orderId) {
        return this._request('DELETE', `/orders/${orderId}`, {}, true);
    }

    async placeBuyOrder(market, quantity, rate, timeInForce = 'GOOD_TILL_CANCELLED', orderType = 'LIMIT') {
        const params = {
            marketSymbol: market,
            direction: 'BUY',
            type: orderType,
            quantity: quantity.toString(),
            limit: rate.toString(),
            timeInForce
        };
        return this._request('POST', '/orders', params, true);
    }

    async placeSellOrder(market, quantity, rate, timeInForce = 'GOOD_TILL_CANCELLED', orderType = 'LIMIT') {
        const params = {
            marketSymbol: market,
            direction: 'SELL',
            type: orderType,
            quantity: quantity.toString(),
            limit: rate.toString(),
            timeInForce
        };
        return this._request('POST', '/orders', params, true);
    }

    async withdraw(currency, quantity, address, addressTag = null) {
        const params = {
            currencySymbol: currency,
            quantity: quantity.toString(),
            cryptoAddress: address
        };
        
        if (addressTag) {
            params.cryptoAddressTag = addressTag;
        }

        return this._request('POST', '/withdrawals', params, true);
    }

    async getDepositAddress(currency) {
        return this._request('GET', `/addresses/${currency}`, {}, true);
    }

    async getDepositHistory(options = {}) {
        return this._request('GET', '/deposits/open', options, true);
    }

    async getWithdrawalHistory(options = {}) {
        return this._request('GET', '/withdrawals/open', options, true);
    }

    // Utility methods
    getRequestCount() {
        return this.requestCount;
    }

    resetRequestCount() {
        this.requestCount = 0;
    }

    // Rate limiting helper
    async waitForRateLimit(delayMs = 1000) {
        return new Promise(resolve => setTimeout(resolve, delayMs));
    }
}
