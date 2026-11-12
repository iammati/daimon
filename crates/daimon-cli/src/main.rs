mod precmd;
mod preexec;
mod setup;
mod shell_profiling;

fn main() -> anyhow::Result<()> {
    let mut args = std::env::args().skip(1);
    match args.next().as_deref() {
        Some("precmd")          => precmd::run(),
        Some("preexec")         => preexec::run(),
        Some("setup")           => setup::run(),
        Some("shell-profiling") => shell_profiling::run(),
        Some(cmd) => {
            eprintln!("daimon: unknown command '{cmd}'");
            eprintln!("usage: daimon <precmd|preexec|setup|shell-profiling>");
            std::process::exit(1)
        }
        None => {
            eprintln!("usage: daimon <precmd|preexec|setup|shell-profiling>");
            std::process::exit(1)
        }
    }
}
