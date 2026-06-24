use anyhow::{bail, Context, Result};
use clap::{Args, Parser, Subcommand};
use fiber_mpp_core::{canonical_json, resource_hash, sha256_hex, verify_receipt, verify_vectors_dir, ConformanceReport};
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Parser)]
#[command(name = "fiber-mpp-rs", version, about = "Rust primary stack for FiberMPP")]
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
    Verify {
        file: PathBuf,
        #[arg(long)]
        secret: Option<String>,
    },
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

fn main() -> Result<()> {
    match Cli::parse().command {
        Commands::Vectors { command: VectorCommands::Verify } => vectors_verify(),
        Commands::Receipt { command: ReceiptCommands::Verify { file, secret } } => receipt_verify(&file, secret),
        Commands::Challenge { command: ChallengeCommands::Inspect { file } } => challenge_inspect(&file),
        Commands::Server(args) => {
            let report = fiber_mpp_server::inspect_config(args.config)?;
            println!("{}", serde_json::to_string_pretty(&report)?);
            Ok(())
        }
        Commands::Doctor => {
            println!(
                "{}",
                serde_json::to_string_pretty(&json!({
                    "engine": "rust",
                    "status": "ok",
                    "canonical_engine": true,
                    "trusted_boundary": "rust",
                    "fiber_rpc_semantics": fiber_mpp_fiber::live_proven_semantics()
                }))?
            );
            Ok(())
        }
        Commands::Version => {
            println!(
                "{}",
                serde_json::to_string_pretty(&json!({
                    "engine": "rust",
                    "binary": "fiber-mpp-rs",
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

fn receipt_verify(file: &Path, secret: Option<String>) -> Result<()> {
    let value: Value = serde_json::from_str(&fs::read_to_string(file)?)?;
    let receipt = if value.get("input").is_some() {
        value.get("input").and_then(|input| input.get("receipt")).context("vector input does not contain receipt")?.clone()
    } else {
        value
    };
    let secret = secret
        .or_else(|| std::env::var("FIBER_MPP_SECRET").ok())
        .unwrap_or_else(|| "fiber-mpp-live-e2e-secret-at-least-16".to_string());
    let valid = verify_receipt(&receipt, &secret)?;
    println!(
        "{}",
        serde_json::to_string_pretty(&json!({
            "engine": "rust",
            "valid": valid
        }))?
    );
    if !valid {
        bail!("receipt signature is invalid");
    }
    Ok(())
}

fn challenge_inspect(file: &Path) -> Result<()> {
    let value: Value = serde_json::from_str(&fs::read_to_string(file)?)?;
    let input = value.get("input").unwrap_or(&value);
    let challenge = input.get("challenge").unwrap_or(input);
    let signature = input.get("signature").and_then(Value::as_str);
    let secret = input.get("secret").and_then(Value::as_str);
    let signature_valid = match (signature, secret) {
        (Some(signature), Some(secret)) => Some(fiber_mpp_core::sign_value(challenge, secret)? == signature),
        _ => None,
    };
    let resource = challenge.get("resource");
    println!(
        "{}",
        serde_json::to_string_pretty(&json!({
            "engine": "rust",
            "canonical_hash": sha256_hex(canonical_json(challenge)?.as_bytes()),
            "signature_valid": signature_valid,
            "resource_hash": match resource {
                Some(resource) => Some(resource_hash(resource)?),
                None => None
            },
            "challenge": challenge
        }))?
    );
    Ok(())
}

fn write_json(path: impl AsRef<Path>, value: &ConformanceReport) -> Result<()> {
    fs::write(path, format!("{}\n", serde_json::to_string_pretty(value)?))?;
    Ok(())
}
