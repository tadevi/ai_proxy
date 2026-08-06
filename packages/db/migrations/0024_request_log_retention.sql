DELETE FROM "request_logs"
WHERE "id" IN (
  SELECT "id"
  FROM (
    SELECT
      "id",
      row_number() OVER (
        PARTITION BY "user_id"
        ORDER BY "created_at" DESC, "id" DESC
      ) AS "row_number"
    FROM "request_logs"
  ) AS "ranked"
  WHERE "ranked"."row_number" > 500
);
