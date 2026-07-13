use anyhow::{bail, Context, Result};
use clap::{Args, Parser, Subcommand};
use fiber_paid_http_core::{
    canonical_json, decode_fiber_charge_request, sha256_hex, validate_receipt, verify_vectors_dir,
    ConformanceReport, PaymentChallenge, PaymentReceipt,
};
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Parser)]
#[command(
    name = "fiber-paid-http-rs",
    version,
    about = "Rust production gateway and verifier for Fiber Paid HTTP"
)]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Debug, Subcommand)]
enum Commands {
    Vectors {
        #[command(subcommand)]
        command: VectorCommands,
    },
    Receipt {
        #[command(subcommand)]
        command: ReceiptCommands,
    },
    Challenge {
        #[command(subcommand)]
        command: ChallengeCommands,
    },
    Server(ServerArgs),
    Doctor,
    Version,
}

#[derive(Debug, Subcommand)]
enum VectorCommands {
    Verify,
}

#[derive(Debug, Subcommand)]
enum ReceiptCommands {
    Verify { file: PathBuf },
}

#[derive(Debug, Subcommand)]
enum ChallengeCommands {
    Inspect { file: PathBuf },
}

#[derive(Debug, Args)]
struct ServerArgs {
    #[arg(long)]
    config: PathBuf,
}

#[tokio::main]
async fn main() -> Result<()> {
    match Cli::parse().command {
        Commands::Vectors {
            command: VectorCommands::Verify,
        } => vectors_verify(),
        Commands::Receipt {
            command: ReceiptCommands::Verify { file },
        } => receipt_verify(&file),
        Commands::Challenge {
            command: ChallengeCommands::Inspect { file },
        } => challenge_inspect(&file),
        Commands::Server(args) => fiber_paid_http_server::serve_config(args.config)
            .await
            .map_err(Into::into),
        Commands::Doctor => {
            println!(
                "{}",
                serde_json::to_string_pretty(&json!({
                    "engine": "rust",
                    "status": "ok",
                    "canonical_engine": true,
                    "trusted_boundary": "rust",
                    "fiber_rpc_semantics": fiber_paid_http_fiber::live_proven_semantics()
                }))?
            );
            Ok(())
        }
        Commands::Version => {
            println!(
                "{}",
                serde_json::to_string_pretty(&json!({
                    "engine": "rust",
                    "binary": "fiber-paid-http-rs",
                    "version": env!("CARGO_PKG_VERSION"),
                    "canonical_engine": true,
                    "trusted_boundary": "rust"
                }))?
            );
            Ok(())
        }
    }
}

fn vectors_verify() -> Result<()> {
    fs::create_dir_all("reports")?;
    let report = verify_vectors_dir("test-vectors").context("verify Rust vectors")?;
    write_json("reports/rust-conformance.json", &report)?;
    println!("{}", serde_json::to_string_pretty(&report)?);
    if report.failed > 0 {
        bail!("Rust conformance failed for {} vectors", report.failed);
    }
    Ok(())
}

fn receipt_verify(file: &Path) -> Result<()> {
    let value: Value = serde_json::from_str(&fs::read_to_string(file)?)?;
    let receipt = if value.get("input").is_some() {
        value
            .get("input")
            .and_then(|input| input.get("receipt"))
            .context("vector input does not contain receipt")?
            .clone()
    } else {
        value
    };
    let receipt: PaymentReceipt = serde_json::from_value(receipt)?;
    let valid = validate_receipt(&receipt).is_ok();
    println!(
        "{}",
        serde_json::to_string_pretty(&json!({
            "engine": "rust",
            "valid": valid
        }))?
    );
    if !valid {
        bail!("receipt schema is invalid");
    }
    Ok(())
}

fn challenge_inspect(file: &Path) -> Result<()> {
    let value: Value = serde_json::from_str(&fs::read_to_string(file)?)?;
    let input = value.get("input").unwrap_or(&value);
    let challenge_value = input.get("challenge").unwrap_or(input);
    let challenge: PaymentChallenge = serde_json::from_value(challenge_value.clone())?;
    let charge = decode_fiber_charge_request(&challenge.request)?;
    println!(
        "{}",
        serde_json::to_string_pretty(&json!({
            "engine": "rust",
            "canonical_hash": sha256_hex(canonical_json(challenge_value)?.as_bytes()),
            "challenge": challenge,
            "charge_request": charge
        }))?
    );
    Ok(())
}

fn write_json(path: impl AsRef<Path>, value: &ConformanceReport) -> Result<()> {
    fs::write(path, format!("{}\n", serde_json::to_string_pretty(value)?))?;
    Ok(())
}
