import {IBeaconConfig} from "@chainsafe/lodestar-config";
import {SignedBeaconBlock, Slot} from "@chainsafe/lodestar-types";
import {AbortController, AbortSignal} from "abort-controller";
import {ILogger, sleep} from "@chainsafe/lodestar-utils";
import {toHexString} from "@chainsafe/ssz";
import {EventEmitter} from "events";
import PeerId from "peer-id";
import {IRegularSync, IRegularSyncOptions, RegularSyncEventEmitter} from "..";
import {IBeaconChain} from "../../../chain";
import {INetwork} from "../../../network";
import {GossipEvent} from "../../../network/gossip/constants";
import {checkBestPeer, getBestPeer} from "../../utils";
import {getSyncPeers} from "../../utils/peers";
import {BlockRangeFetcher} from "./fetcher";
import {BlockRangeProcessor} from "./processor";
import {ISyncCheckpoint} from "../../interface";
import {IBlockRangeFetcher, IBlockRangeProcessor, ORARegularSyncModules} from "./interface";

/**
 * One Range Ahead regular sync: fetch one range in advance and buffer blocks.
 * Fetch next range and process blocks at the same time.
 */
export class ORARegularSync extends (EventEmitter as {new (): RegularSyncEventEmitter}) implements IRegularSync {
  private readonly config: IBeaconConfig;

  private readonly network: INetwork;

  private readonly chain: IBeaconChain;

  private readonly logger: ILogger;

  private bestPeer: PeerId | undefined;

  private fetcher: IBlockRangeFetcher;

  private processor: IBlockRangeProcessor;

  private controller!: AbortController;

  private blockBuffer: SignedBeaconBlock[];

  constructor(options: Partial<IRegularSyncOptions>, modules: ORARegularSyncModules) {
    super();
    this.config = modules.config;
    this.network = modules.network;
    this.chain = modules.chain;
    this.logger = modules.logger;
    this.fetcher = modules.fetcher || new BlockRangeFetcher(options, modules, this.getSyncPeers.bind(this));
    this.processor = modules.processor || new BlockRangeProcessor(modules);
    this.blockBuffer = [];
  }

  public async start(): Promise<void> {
    const headSlot = this.chain.forkChoice.getHead().slot;
    const currentSlot = this.chain.clock.currentSlot;
    this.logger.info("Started regular syncing", {currentSlot, headSlot});
    this.logger.verbose(`Regular Sync: Current slot at start: ${currentSlot}`);
    this.controller = new AbortController();
    await this.processor.start();
    this.network.gossip.subscribeToBlock(await this.chain.getForkDigest(), this.onGossipBlock);
    this.chain.emitter.on("block", this.onProcessedBlock);
    this.sync().catch((e) => {
      this.logger.error("Regular Sync: error", e);
    });
  }

  public async stop(): Promise<void> {
    if (this.controller && !this.controller.signal.aborted) {
      this.controller.abort();
    }
    await this.processor.stop();
    this.network.gossip.unsubscribe(await this.chain.getForkDigest(), GossipEvent.BLOCK, this.onGossipBlock);
    this.chain.emitter.off("block", this.onProcessedBlock);
  }

  public setLastProcessedBlock(lastProcessedBlock: ISyncCheckpoint): void {
    this.fetcher.setLastProcessedBlock(lastProcessedBlock);
  }

  public getHighestBlock(): Slot {
    const lastBlock = this.blockBuffer.length > 0 ? this.blockBuffer[this.blockBuffer.length - 1].message.slot : 0;
    return lastBlock ?? this.chain.forkChoice.getHead().slot;
  }

  private onGossipBlock = async (block: SignedBeaconBlock): Promise<void> => {
    const gossipParentBlockRoot = block.message.parentRoot;
    if (this.chain.forkChoice.hasBlock(gossipParentBlockRoot as Uint8Array)) {
      this.logger.important("Regular Sync: caught up to gossip block parent " + toHexString(gossipParentBlockRoot));
      this.emit("syncCompleted");
      await this.stop();
    }
  };

  private onProcessedBlock = async (signedBlock: SignedBeaconBlock): Promise<void> => {
    if (signedBlock.message.slot >= this.chain.clock.currentSlot) {
      this.logger.info(`Regular Sync: processed up to current slot ${signedBlock.message.slot}`);
      this.emit("syncCompleted");
      await this.stop();
    }
  };

  private async sync(): Promise<void> {
    this.blockBuffer = await this.fetcher.next();
    while (!this.controller.signal.aborted) {
      // blockBuffer is always not empty
      const lastSlot = this.blockBuffer[this.blockBuffer.length - 1].message.slot;
      const result = await Promise.all([
        this.fetcher.next(),
        this.processor.processUntilComplete([...this.blockBuffer], this.controller.signal),
      ]);
      if (!result[0] || !result[0].length) {
        // node is stopped
        this.logger.info("Regular Sync: fetcher returns empty array, finish sync now");
        return;
      }
      this.blockBuffer = result[0];
      this.logger.info(`Regular Sync: Synced up to slot ${lastSlot} `, {
        currentSlot: this.chain.clock.currentSlot,
      });
    }
  }

  /**
   * Make sure the best peer is not disconnected and it's better than us.
   */
  private getSyncPeers = async (): Promise<PeerId[]> => {
    if (!checkBestPeer(this.bestPeer!, this.chain.forkChoice, this.network)) {
      this.logger.info("Regular Sync: wait for best peer");
      this.bestPeer = undefined;
      await this.waitForBestPeer(this.controller.signal);
      if (this.controller.signal.aborted) return [];
    }
    return [this.bestPeer!];
  };

  private waitForBestPeer = async (signal: AbortSignal): Promise<void> => {
    // statusSyncTimer is per slot
    const waitingTime = this.config.params.SECONDS_PER_SLOT * 1000;

    while (!this.bestPeer) {
      const peers = getSyncPeers(this.network, undefined, this.network.getMaxPeer());
      this.bestPeer = getBestPeer(this.config, peers, this.network.peerMetadata);
      if (checkBestPeer(this.bestPeer, this.chain.forkChoice, this.network)) {
        const peerHeadSlot = this.network.peerMetadata.getStatus(this.bestPeer)!.headSlot;
        this.logger.info(`Regular Sync: Found best peer ${this.bestPeer.toB58String()}`, {
          peerHeadSlot,
          currentSlot: this.chain.clock.currentSlot,
        });
      } else {
        // continue to find best peer
        this.bestPeer = undefined;
        await sleep(waitingTime, signal);
      }
    }
  };
}
