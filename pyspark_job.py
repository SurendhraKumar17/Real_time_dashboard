"""Aggregate the complete NYC TLC January 2015 dataset with PySpark.

The output is compatible with the dashboard API payload.  Spark reads the
entire CSV and performs the aggregation in parallel; no sampling or row limit
is applied.
"""

from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path

from pyspark.sql import DataFrame, SparkSession
from pyspark.sql.functions import avg, col, count, sum as sum_, when
from pyspark.sql.types import DoubleType, IntegerType, StringType, StructField, StructType


PAYMENT_LABELS = {
    "1": "Credit card",
    "2": "Cash",
    "3": "No charge",
    "4": "Dispute",
    "5": "Unknown",
    "6": "Voided trip",
}

TRIP_SCHEMA = StructType(
    [
        StructField("VendorID", IntegerType(), True),
        StructField("tpep_pickup_datetime", StringType(), True),
        StructField("tpep_dropoff_datetime", StringType(), True),
        StructField("passenger_count", DoubleType(), True),
        StructField("trip_distance", DoubleType(), True),
        StructField("pickup_longitude", DoubleType(), True),
        StructField("pickup_latitude", DoubleType(), True),
        StructField("RateCodeID", IntegerType(), True),
        StructField("store_and_fwd_flag", StringType(), True),
        StructField("dropoff_longitude", DoubleType(), True),
        StructField("dropoff_latitude", DoubleType(), True),
        StructField("payment_type", StringType(), True),
        StructField("fare_amount", DoubleType(), True),
        StructField("extra", DoubleType(), True),
        StructField("mta_tax", DoubleType(), True),
        StructField("tip_amount", DoubleType(), True),
        StructField("tolls_amount", DoubleType(), True),
        StructField("improvement_surcharge", DoubleType(), True),
        StructField("total_amount", DoubleType(), True),
    ]
)


def read_trips(spark: SparkSession, input_path: str) -> DataFrame:
    """Read every data row from the TLC CSV using the known column types."""
    return (
        spark.read.option("header", True)
        .option("mode", "PERMISSIVE")
        .schema(TRIP_SCHEMA)
        .csv(input_path)
        .select(
            "payment_type",
            "passenger_count",
            "trip_distance",
            "fare_amount",
            "total_amount",
        )
    )


def build_snapshot(trips: DataFrame) -> dict:
    """Aggregate all trips by payment type into the dashboard response shape."""
    safe_trips = trips.fillna(
        {
            "payment_type": "Unknown",
            "passenger_count": 0.0,
            "trip_distance": 0.0,
            "fare_amount": 0.0,
            "total_amount": 0.0,
        }
    )
    grouped = (
        safe_trips.groupBy("payment_type")
        .agg(
            count("*").alias("trips"),
            sum_("passenger_count").alias("passengers"),
            sum_("trip_distance").alias("distance"),
            sum_("fare_amount").alias("fare"),
            sum_("total_amount").alias("revenue"),
            avg("passenger_count").alias("averagePassengers"),
            avg("trip_distance").alias("averageDistance"),
            avg("fare_amount").alias("averageFare"),
        )
        .withColumn(
            "payment_type",
            when(col("payment_type").isNull(), "Unknown").otherwise(col("payment_type")),
        )
        .orderBy(col("trips").desc())
    )

    rows = [
        {
            "id": str(row.payment_type),
            "name": PAYMENT_LABELS.get(str(row.payment_type), f"Payment type {row.payment_type}"),
            "channel": "Payment method",
            "trips": int(row.trips),
            "passengers": float(row.passengers),
            "distance": float(row.distance),
            "revenue": float(row.revenue),
            "fare": float(row.fare),
            "averageFare": float(row.averageFare),
            "averageDistance": float(row.averageDistance),
            "averagePassengers": float(row.averagePassengers),
        }
        for row in grouped.collect()
    ]
    totals = {
        "trips": sum(row["trips"] for row in rows),
        "passengers": sum(row["passengers"] for row in rows),
        "distance": sum(row["distance"] for row in rows),
        "revenue": sum(row["revenue"] for row in rows),
    }
    totals["averageFare"] = (
        sum(row["fare"] for row in rows) / totals["trips"] if totals["trips"] else 0.0
    )
    totals["averageDistance"] = (
        totals["distance"] / totals["trips"] if totals["trips"] else 0.0
    )
    totals["averagePassengers"] = (
        totals["passengers"] / totals["trips"] if totals["trips"] else 0.0
    )
    return {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "source": "Local NYC TLC Yellow Taxi Trip Records (January 2015)",
        "sourceUrl": "/yellow_tripdata_2015-01.csv",
        "recordsFetched": totals["trips"],
        "campaigns": rows,
        "totals": totals,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--input",
        default=str(Path(__file__).with_name("yellow_tripdata_2015-01.csv")),
        help="Path to the complete TLC CSV dataset.",
    )
    parser.add_argument(
        "--output",
        type=Path,
        help="Optional path for the dashboard-compatible JSON output.",
    )
    args = parser.parse_args()

    input_path = Path(args.input)
    if not input_path.is_file():
        parser.error(f"Input dataset does not exist: {input_path}")

    spark = (
        SparkSession.builder.appName("NYCTaxiFullDatasetAggregation")
        .config("spark.sql.session.timeZone", "UTC")
        .getOrCreate()
    )
    try:
        snapshot = build_snapshot(read_trips(spark, str(input_path)))
        payload = json.dumps(snapshot, indent=2)
        if args.output:
            args.output.parent.mkdir(parents=True, exist_ok=True)
            args.output.write_text(payload + "\n", encoding="utf-8")
        else:
            print(payload)
    finally:
        spark.stop()


if __name__ == "__main__":
    main()