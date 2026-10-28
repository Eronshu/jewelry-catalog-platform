-- Local fixture safety fence only. Every normalized receipt is still unresolved.
-- A hint cannot prove an orphan event is unrelated to a different payment channel.
-- Keep 0014 provenance and CREATE guards; add no association or financial facts.
-- Existing starts/receipts and all business state remain unchanged.
CREATE TRIGGER commerce_execution_start_event_fence
BEFORE INSERT ON commerce_payment_execution_starts
WHEN NEW.operation = 'create' AND EXISTS (
  SELECT 1 FROM commerce_payment_event_receipts r
  WHERE r.mode = NEW.mode AND r.instance_id = NEW.instance_id
)
BEGIN SELECT RAISE(ABORT,'commerce_execution_start_event_fence'); END;
