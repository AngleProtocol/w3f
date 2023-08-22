import {
  Web3Function
} from "@gelatonetwork/web3-functions-sdk";

import { Contract } from "ethers";
import { EvmPriceServiceConnection as EvmPriceServiceConnection2 } from "@pythnetwork/pyth-evm-js";
import PythAbi from "@pythnetwork/pyth-sdk-solidity/abis/IPyth.json";

// web3-functions/pyth-oracle-w3f-priceIds/pythUtils.ts
import { Octokit } from "octokit";
import YAML from "yaml";
import { Price } from "@pythnetwork/pyth-evm-js";

const ORACLE_ABI = [
  "function getPriceUnsafe(bytes32) view returns (tuple(int64,uint64,int32,uint256))",
];

function addLeading0x(id: string) {
  if (id.startsWith("0x")) {
    return id;
  }
  return "0x" + id;
}

function shouldFetchPythConfig(pythConfigStorage: any) {
  const isNotFoundInStorage = pythConfigStorage.pythConfig === void 0;
  return isNotFoundInStorage || Date.now() / 1e3 - pythConfigStorage.timestamp > pythConfigStorage.pythConfig.configRefreshRateInSeconds;
}

async function fetchPythConfigIfNecessary(storage: any, gistId: string) {
  const octokit = new Octokit();
  let pythConfig;
  let pythConfigStorage = JSON.parse(
    await storage.get("pythConfig") ?? "{}"
  );
  if (shouldFetchPythConfig(pythConfigStorage)) {
    const gistDetails = await octokit.rest.gists.get({ gist_id: gistId });
    const files = gistDetails.data.files;
    if (!files)
      throw new Error(`No files in gist`);
    for (const file of Object.values(files)) {
      if (file?.filename === "config.yaml" && file.content) {
        pythConfig = YAML.parse(file.content);
        break;
      }
    }
    if (!pythConfig)
      throw new Error(`No config.yaml loaded for PythConfig`);
    pythConfigStorage = {
      timestamp: Date.now() / 1e3,
      pythConfig
    };
    const pythConfigStorageValue = JSON.stringify(pythConfigStorage);
    if (pythConfig.debug) {
      console.debug(
        `storing fetched pythConfigStorageValue: ${pythConfigStorageValue}`
      );
    }
    await storage.set("pythConfig", pythConfigStorageValue);
  } else {
    pythConfig = pythConfigStorage.pythConfig;
    if (pythConfig.debug) {
      console.debug("using pythConfig from storage");
    }
  }
  return pythConfig;
}
async function getCurrentPrices(priceIds: string[], connection: any, debug: boolean) {
  const latestPriceFeeds = await connection.getLatestPriceFeeds(priceIds);
  if (latestPriceFeeds === void 0) {
    return void 0;
  }
  if (debug) {
    console.debug(`latestPriceFeeds: ${JSON.stringify(latestPriceFeeds)}`);
  }
  return latestPriceFeeds.map((pf: any) => {
    return {
      id: pf.id,
      price: pf.getPriceUnchecked(),
    };
  }).filter((pf: any) => {
    return pf !== void 0 && pf.price !== void 0;
  }).reduce((acc: any, pf: any) => {
    acc.set(addLeading0x(pf.id), pf.price);
    return acc;
  }, /* @__PURE__ */ new Map());
}

async function getLastPricesFromChain(provider: any, oracleAddress: string, priceIds: string[], ) {
  let result = new Map();
  let oracle;
  for (const priceId of priceIds) {
    oracle = new Contract(oracleAddress, ORACLE_ABI, provider);
    const priceInfo = await oracle.getPriceUnsafe(priceId);
    // decode result
    const price = priceInfo[0].toString();
    const expo = parseInt(priceInfo[2].toString());
    const publishTime = parseInt(priceInfo[3].toString());
    const priceInfoJson = {
      price,
      expo,
      publishTime
    }
    result.set(priceId, priceInfoJson);
  }
  return result;
}

function generatePriceUpdateList(
  priceIds: any,
  currentPrices: any,
  lastPrices: any,
  allPriceIdsByItem: { [key: string]: string[] },
  validTimePeriodSeconds: number,
  deviationThresholdBps: number,
  debug: boolean
): string[] {

  const priceUpdateList: string[] = [];

  for (const item of Object.keys(priceIds)) {
    let composedLastPrice = 0;
    let composedCurrentPrice = 0;
    const priceIdObj = priceIds[item];
    for (const priceFeed of priceIdObj) {
      const priceId = addLeading0x(priceFeed.id);
      const currentPrice = currentPrices.get(priceId);
      const lastPrice = lastPrices.get(priceId);

      if (currentPrice.publishTime - lastPrice.publishTime > validTimePeriodSeconds) {
        // Price is stale --> update all oracles for this item
        for (const priceId of allPriceIdsByItem[item]) {
          priceUpdateList.push(priceId);
        }
        if (debug) {
          console.debug(`
            Updating all prices for item: ${item}
            PriceIds: ${allPriceIdsByItem[item]}
          `);
        }
        break;
      }

      if (composedLastPrice === 0 && composedCurrentPrice == 0) {
        composedLastPrice = lastPrices.get(priceId).price * (10 ** lastPrices.get(priceId).expo);
        composedCurrentPrice =  currentPrices.get(priceId).price * (10 ** currentPrices.get(priceId).expo);
      } else {
          if (priceFeed.action === "div") {
            composedLastPrice =  composedLastPrice /  (lastPrices.get(priceId).price * (10 ** lastPrices.get(priceId).expo));
            composedCurrentPrice =  composedCurrentPrice /  (currentPrices.get(priceId).price * (10 ** currentPrices.get(priceId).expo));
          } else if (priceFeed.action === "mul") {
            composedLastPrice =  composedLastPrice *  (lastPrices.get(priceId).price * (10 ** lastPrices.get(priceId).expo));
            composedCurrentPrice =  composedCurrentPrice *  (currentPrices.get(priceId).price * (10 ** currentPrices.get(priceId).expo));
          } else {
            throw new Error(`Invalid action: ${priceFeed.action}`);
          }
      }
    }
    let composedPriceDiff = composedLastPrice - composedCurrentPrice;
    composedPriceDiff = composedPriceDiff < 0 ? -composedPriceDiff : composedPriceDiff;
    composedPriceDiff *= 1e4;
    composedPriceDiff /= composedLastPrice;
    const priceExceedsDiff = composedPriceDiff >= deviationThresholdBps;

    if (debug) {
      console.debug(`
        item: ${item}
        composedPriceIds: ${allPriceIdsByItem[item]}
        composedPriceDiff: ${composedPriceDiff}
        priceExceedsDiff: ${priceExceedsDiff}
      `);
    }

    if (priceExceedsDiff) {
      for (const priceId of allPriceIdsByItem[item]) {
        priceUpdateList.push(priceId);
      }
    }
  }

  return [...new Set(priceUpdateList)];
}

// web3-functions/pyth-oracle-w3f-priceIds/index.ts
Web3Function.onRun(async (context) => {
  const { storage, secrets, multiChainProvider } = context;
  const provider = multiChainProvider.default();
  const gistId = await secrets.get("GIST_ID");

  if (!gistId) {
    return {
      canExec: false,
      message: `GIST_ID not set in secrets`
    };
  }
  let pythConfig;

  // Fetch Pyth config from gist
  try {
    pythConfig = await fetchPythConfigIfNecessary(storage, gistId);
  } catch (err) {
    const error = err;
    return {
      canExec: false,
      message: `Error fetching gist: ${error}`
    };
  }
  const debug = pythConfig.debug;
  if (debug) {
    console.debug(`pythConfig: ${JSON.stringify(pythConfig)}`);
  }

  const {
    pythNetworkAddress,
    priceServiceEndpoint,
    validTimePeriodSeconds,
    deviationThresholdBps,
    priceIds,
  } = pythConfig;
  const pythContract = new Contract(
    pythNetworkAddress,
    PythAbi,
    provider
  );

  const connection = new EvmPriceServiceConnection2(priceServiceEndpoint);
  
  // Add composed PriceFeeds to priceIds
  const allPriceIdsByItem: { [key: string]: string[] } = {}

  for (const item of Object.keys(priceIds)) {
    const priceIdObj = priceIds[item];

    if (!allPriceIdsByItem.hasOwnProperty(item)) {
      allPriceIdsByItem[item] = [];
    }

    for (const priceFeed of priceIdObj) {
      allPriceIdsByItem[item].push(addLeading0x(priceFeed.id));
    } 
  }

  // Generate a list of unique priceIds to fetch current and last prices
  const allPriceIds = [...new Set(Object.values(allPriceIdsByItem).flat())];

  if (debug) {
    console.debug(`fetching current prices for priceIds: ${allPriceIds}`);
  }

  const currentPrices = await getCurrentPrices(allPriceIds, connection, debug);
  
  if (currentPrices === void 0) {
    return {
      canExec: false,
      message: `Error fetching latest priceFeeds for priceIds: ${allPriceIds}`
    };
  }
  if (currentPrices.size != allPriceIds.length) {
    const missingPriceIds = allPriceIds.filter((p) => !currentPrices.has(p));
    console.error(
      `Missing latest price feed info for ${JSON.stringify(missingPriceIds)}`
    );
    return { canExec: false, message: "Not all prices available" };
  }

  const lastPrices = await getLastPricesFromChain(provider, pythNetworkAddress, allPriceIds);
  
  if (debug) {
    console.debug(
      `
        currentPrices: ${JSON.stringify([...currentPrices.entries()])}
        lastPrices: ${JSON.stringify([...lastPrices.entries()])}
      `
    );
  }

  const priceIdsToUpdate = generatePriceUpdateList(
    priceIds,
    currentPrices,
    lastPrices,
    allPriceIdsByItem,
    validTimePeriodSeconds,
    deviationThresholdBps,
    debug
  );

  if (priceIdsToUpdate.length > 0) {
    const publishTimes = priceIdsToUpdate.map(
      (priceId) => currentPrices.get(priceId).publishTime
    );
    const updatePriceData = await connection.getPriceFeedsUpdateData(
      priceIdsToUpdate
    );
    const fee = (await pythContract.getUpdateFee(updatePriceData)).toString();
    const callData = await pythContract.interface.encodeFunctionData(
      "updatePriceFeedsIfNecessary",
      [updatePriceData, priceIdsToUpdate, publishTimes]
    );
    return {
      canExec: true,
      callData: [
        {
          to: pythNetworkAddress,
          data: callData,
          value: fee
        }
      ]
    };
  } else {
    return {
      canExec: false,
      message: `No conditions met for price initialization or update for priceIds: ${allPriceIds}`
    };
  }
});