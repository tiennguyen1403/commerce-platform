-- CreateIndex
CREATE INDEX "Order_fulfillmentStatus_status_idx" ON "Order"("fulfillmentStatus", "status");
