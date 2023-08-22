# Pyth Web 3 function

## Configuration
- Create a public gist with the filename `config.yaml`
- Put the gist id in you .env file

### Example Configuration

```yaml
# Address of Pyth contract
# See [https://docs.pyth.network/documentation/pythnet-price-feeds/evm#mainnet]
pythNetworkAddress: "0x4305FB66699C3B2702D4d05CF36551390A4c69C6" # Ethereum Mainnet address
# debug mode
debug: true
# Refresh rate of config in seconds to prevent rate limiting from github
configRefreshRateInSeconds: 3600
# See [https://docs.pyth.network/documentation/pythnet-price-feeds/price-service#public-endpoints]
priceServiceEndpoint: "https://hermes.pyth.network"
# maximum number of seconds between updates
validTimePeriodSeconds: 604800 # 7 days
# update price if diff between previous price and current exceeds threshold 
# units is in basis points
# 100 = 1%
deviationThresholdBps: 100
# All priceIds items should contain at least one element, if only one element, set the action to none
priceIds:
  EUROC/EUR:
    - id: "0xd052e6f54fe29355d6a3c06592fdefe49fae7840df6d8655bf6d6bfb789b56e4" # EUROC/USD
      action: none # First item of list should always be none and it should be the only one
    - id: "0xa995d00bb36a63cef7fd2c287dc105fc8f3d93779f062f09551b0af3e81ec30b" # EUR/USD
      action: div
```