//! `brickman-torrent` — command line front-end for the Brickman Torrent core.
//!
//! Every command is one action and then exits: the download engine only runs
//! while the command is running (see `brickman-torrent run`). All state lives
//! in the persistence files inside the data folder.

mod ui;

use std::path::PathBuf;
use std::process::ExitCode;
use std::time::{Duration, Instant};

use brickman_core::{
    AddOptions, Downloader, DownloaderOptions, Error, Source, TorrentId, default_data_dir,
    default_download_dir,
};

const LEGAL_NOTICE: &str = "\
Legal: Brickman Torrent is a BitTorrent client without search, catalogue or
built-in tracker lists. It downloads only torrents you add yourself. Make sure
you have the right to download and share the content you select.";

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("error: {error}");
            ExitCode::FAILURE
        }
    }
}

fn run() -> Result<(), Error> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let Some(command) = args.first() else {
        print_help();
        return Ok(());
    };
    let rest = &args[1..];
    match command.as_str() {
        "add" => cmd_add(rest),
        "list" | "ls" => cmd_list(),
        "pause" => cmd_pause_resume(rest, true),
        "resume" => cmd_pause_resume(rest, false),
        "rm" | "remove" => cmd_remove(rest),
        "priority" => cmd_move(rest, true),
        "move" => cmd_move(rest, false),
        "up" => cmd_step(rest, -1),
        "down" => cmd_step(rest, 1),
        "limits" => cmd_limits(rest),
        "max-active" => cmd_max_active(rest),
        "run" => cmd_run(rest),
        "help" | "--help" | "-h" => {
            print_help();
            Ok(())
        }
        other => Err(Error::InvalidArgument(format!(
            "unknown command {other:?}; run `tc help`"
        ))),
    }
}

fn cmd_add(args: &[String]) -> Result<(), Error> {
    let mut source: Option<String> = None;
    let mut output_dir: Option<PathBuf> = None;
    let mut wait_secs = 0u64;

    let mut index = 0;
    while index < args.len() {
        match args[index].as_str() {
            "--dir" => output_dir = Some(PathBuf::from(take_value(args, &mut index)?)),
            "--wait" => {
                wait_secs = take_value(args, &mut index)?
                    .parse()
                    .map_err(|_| Error::InvalidArgument("--wait expects seconds".to_string()))?;
            }
            flag if flag.starts_with('-') => {
                return Err(Error::InvalidArgument(format!("unknown flag {flag:?}")));
            }
            value if source.is_none() => source = Some(value.to_string()),
            value => {
                return Err(Error::InvalidArgument(format!(
                    "unexpected argument {value:?}"
                )));
            }
        }
        index += 1;
    }

    let source_raw = source.ok_or_else(|| {
        Error::InvalidArgument(
            "usage: brickman-torrent add <path/to/file.torrent | magnet:?...> [--dir DIR] [--wait SECS]"
                .to_string(),
        )
    })?;
    let source = Source::parse(&source_raw)?;
    let is_magnet = matches!(source, Source::Magnet(_));

    let downloader = open(true)?;
    let spinner = is_magnet.then(|| ui::Spinner::start("fetching metadata"));
    let result = downloader.add(
        source,
        AddOptions {
            output_dir,
            ..Default::default()
        },
    );
    if let Some(spinner) = spinner {
        spinner.stop();
    }
    let id = result?;

    match downloader.list().into_iter().find(|view| view.id == id) {
        Some(view) => println!(
            "added #{} {:?} ({}), priority {}, saving to {}",
            view.id,
            view.name,
            ui::human_bytes(view.total_bytes),
            view.priority,
            view.save_path.display()
        ),
        None => println!("added #{id}"),
    }

    if wait_secs > 0 {
        run_engine(&downloader, Some(Duration::from_secs(wait_secs)))?;
    }
    Ok(())
}

fn cmd_list() -> Result<(), Error> {
    let downloader = open(false)?;
    print!("{}", ui::render_table(&downloader.list()));
    Ok(())
}

fn cmd_pause_resume(args: &[String], pause: bool) -> Result<(), Error> {
    let target = args.first().ok_or_else(|| {
        Error::InvalidArgument(if pause {
            "usage: brickman-torrent pause <id|all>".to_string()
        } else {
            "usage: brickman-torrent resume <id|all>".to_string()
        })
    })?;

    let downloader = open(false)?;
    if target == "all" {
        if pause {
            downloader.pause_all()?;
        } else {
            downloader.resume_all()?;
        }
        println!(
            "{} all torrents",
            if pause { "paused" } else { "resumed" }
        );
    } else {
        let id: TorrentId = target.parse()?;
        if pause {
            downloader.pause(id)?;
        } else {
            downloader.resume(id)?;
        }
        println!("{} #{id}", if pause { "paused" } else { "resumed" });
    }
    print!("{}", ui::render_table(&downloader.list()));
    Ok(())
}

fn cmd_remove(args: &[String]) -> Result<(), Error> {
    let mut id: Option<TorrentId> = None;
    let mut delete_files = false;
    for arg in args {
        match arg.as_str() {
            "--files" => delete_files = true,
            flag if flag.starts_with('-') => {
                return Err(Error::InvalidArgument(format!("unknown flag {flag:?}")));
            }
            value if id.is_none() => id = Some(value.parse()?),
            value => {
                return Err(Error::InvalidArgument(format!(
                    "unexpected argument {value:?}"
                )));
            }
        }
    }
    let id = id.ok_or_else(|| {
        Error::InvalidArgument("usage: brickman-torrent rm <id> [--files]".to_string())
    })?;

    let downloader = open(false)?;
    downloader.remove(id, delete_files)?;
    println!(
        "removed #{id}{}",
        if delete_files {
            " and deleted its files"
        } else {
            " (files kept)"
        }
    );
    Ok(())
}

/// `move <id> <position>` (and the `priority` alias): the number is a 1-based
/// queue position, `1` = first. The torrents between the old and the new
/// position shift by one, exactly like dragging a row in the desktop app.
fn cmd_move(args: &[String], alias: bool) -> Result<(), Error> {
    let usage = if alias {
        "usage: brickman-torrent priority <id> <position>"
    } else {
        "usage: brickman-torrent move <id> <position>"
    };
    if args.len() != 2 {
        return Err(Error::InvalidArgument(usage.to_string()));
    }
    let id: TorrentId = args[0].parse()?;
    let number: u32 = args[1].parse().map_err(|_| {
        Error::InvalidArgument("position must be a number, 1 = first".to_string())
    })?;

    let downloader = open(false)?;
    downloader.set_priority(id, number)?;
    println!(
        "#{id} is now at queue position {}",
        downloader.position(id)
    );
    print!("{}", ui::render_table(&downloader.list()));
    Ok(())
}

/// `up <id>` / `down <id>`: one queue position in either direction.
fn cmd_step(args: &[String], delta: isize) -> Result<(), Error> {
    let usage = if delta < 0 {
        "usage: brickman-torrent up <id>"
    } else {
        "usage: brickman-torrent down <id>"
    };
    let target = args
        .first()
        .ok_or_else(|| Error::InvalidArgument(usage.to_string()))?;
    let id: TorrentId = target.parse()?;

    let downloader = open(false)?;
    if delta < 0 {
        downloader.move_up(id)?;
    } else {
        downloader.move_down(id)?;
    }
    println!(
        "#{id} is now at queue position {}",
        downloader.position(id)
    );
    print!("{}", ui::render_table(&downloader.list()));
    Ok(())
}

fn cmd_limits(args: &[String]) -> Result<(), Error> {
    let mut down: Option<u64> = None;
    let mut up: Option<u64> = None;

    let mut index = 0;
    while index < args.len() {
        match args[index].as_str() {
            "--down" => down = Some(parse_kib(take_value(args, &mut index)?)?),
            "--up" => up = Some(parse_kib(take_value(args, &mut index)?)?),
            flag => {
                return Err(Error::InvalidArgument(format!("unknown flag {flag:?}")));
            }
        }
        index += 1;
    }

    let downloader = open(false)?;
    if down.is_some() || up.is_some() {
        let current = downloader.limits();
        downloader.set_limits(
            Some(down.unwrap_or(current.down_bps.unwrap_or(0))),
            Some(up.unwrap_or(current.up_bps.unwrap_or(0))),
        )?;
    }
    let limits = downloader.limits();
    println!(
        "limits: down {}, up {}",
        limit_text(limits.down_bps),
        limit_text(limits.up_bps)
    );
    Ok(())
}

fn cmd_max_active(args: &[String]) -> Result<(), Error> {
    let value = args
        .first()
        .ok_or_else(|| Error::InvalidArgument("usage: brickman-torrent max-active <n>".to_string()))?;
    let n: u32 = value
        .parse()
        .map_err(|_| Error::InvalidArgument("max-active expects a number".to_string()))?;

    let downloader = open(false)?;
    downloader.set_max_active(n)?;
    println!(
        "maximum active downloads: {}",
        if n == 0 {
            "unlimited".to_string()
        } else {
            n.to_string()
        }
    );
    print!("{}", ui::render_table(&downloader.list()));
    Ok(())
}

fn cmd_run(args: &[String]) -> Result<(), Error> {
    let mut seconds: Option<u64> = None;
    let mut index = 0;
    while index < args.len() {
        match args[index].as_str() {
            "--seconds" | "--for" => {
                seconds = Some(
                    take_value(args, &mut index)?
                        .parse()
                        .map_err(|_| Error::InvalidArgument("--seconds expects a number".to_string()))?,
                );
            }
            flag => {
                return Err(Error::InvalidArgument(format!("unknown flag {flag:?}")));
            }
        }
        index += 1;
    }

    let downloader = open(true)?;
    run_engine(&downloader, seconds.map(Duration::from_secs))?;
    print!("{}", ui::render_table(&downloader.list()));
    Ok(())
}

fn run_engine(downloader: &Downloader, max_duration: Option<Duration>) -> Result<(), Error> {
    let started = Instant::now();
    let result = downloader.run_until(max_duration, |views| {
        ui::print_status_line(&ui::render_status_line(views, started.elapsed()));
    });
    ui::clear_status_line();
    result
}

fn open(networking: bool) -> Result<Downloader, Error> {
    let options = DownloaderOptions::new(default_data_dir(), default_download_dir());
    let options = if networking {
        options
    } else {
        options.read_only()
    };
    Downloader::new(options)
}

fn take_value(args: &[String], index: &mut usize) -> Result<String, Error> {
    *index += 1;
    args.get(*index)
        .cloned()
        .ok_or_else(|| Error::InvalidArgument("missing option value".to_string()))
}

fn parse_kib(value: String) -> Result<u64, Error> {
    let kib: u64 = value
        .parse()
        .map_err(|_| Error::InvalidArgument("limit expects KiB/s as a number".to_string()))?;
    Ok(kib * 1024)
}

fn limit_text(bps: Option<u64>) -> String {
    match bps {
        None | Some(0) => "unlimited".to_string(),
        Some(bps) => ui::human_rate(bps),
    }
}

fn print_help() {
    println!(
        "brickman-torrent {} - Brickman Torrent command line

Usage:
  brickman-torrent add <path/to/file.torrent | magnet:?...> [--dir DIR] [--wait SECS]
  brickman-torrent list
  brickman-torrent pause <id|all>
  brickman-torrent resume <id|all>
  brickman-torrent rm <id> [--files]
  brickman-torrent move <id> <position>
  brickman-torrent up <id>
  brickman-torrent down <id>
  brickman-torrent priority <id> <position>
  brickman-torrent limits [--down <KiB/s>] [--up <KiB/s>]
  brickman-torrent max-active <n>
  brickman-torrent run [--seconds SECS]

Environment:
  TC_DATA_DIR       state folder (default: %APPDATA%\\BrickmanTorrent)
  TC_DOWNLOAD_DIR   default download folder (default: %USERPROFILE%\\Downloads)

Notes:
  * every command terminates; `run` is the foreground engine and stops
    after --seconds or on Ctrl+C,
  * the queue is the list order: `move`/`priority` place a torrent at a
    1-based position (1 = first), `up`/`down` shift it by one,
  * the first torrent in the queue downloads first; finished torrents leave
    the download queue and the next one starts,
  * `max-active 0` disables the limit, the default is 1,
  * `rm <id>` keeps the downloaded files, `--files` deletes them.

{}",
        env!("CARGO_PKG_VERSION"),
        LEGAL_NOTICE
    );
}
