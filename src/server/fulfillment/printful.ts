import type {
  CreateFulfillmentInput,
  FulfillmentProvider,
  FulfillmentResult,
  TrackingInfo,
} from "./provider";

/**
 * Printful (print-on-demand) adapter — skeleton.
 * Implement against https://developers.printful.com in Phase 4.
 * POD is preferred over classic AliExpress dropshipping: real API, faster
 * shipping, differentiated product, and far less payment-processor risk.
 */
export class PrintfulProvider implements FulfillmentProvider {
  readonly name = "printful";

  async createOrder(input: CreateFulfillmentInput): Promise<FulfillmentResult> {
    void input;
    throw new Error("PrintfulProvider.createOrder not implemented yet");
  }

  async getTracking(externalId: string): Promise<TrackingInfo> {
    void externalId;
    throw new Error("PrintfulProvider.getTracking not implemented yet");
  }
}
