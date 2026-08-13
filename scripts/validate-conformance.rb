#!/usr/bin/env ruby

require "date"
require "json"
require "optparse"
require "pathname"
require "yaml"

options = {report: false, require_verified: []}

parser = OptionParser.new do |opts|
  opts.banner = "Usage: ruby scripts/validate-conformance.rb [LEDGER] [options]"
  opts.on("--report", "Print status and per-deployment proof coverage") { options[:report] = true }
  opts.on("--require-verified DEPLOYMENT", "Fail unless every applicable requirement is proved for this deployment") do |deployment|
    options[:require_verified] << deployment
  end
end

parser.parse!
ledger_argument = ARGV.shift || "conformance.yml"
abort parser.to_s unless ARGV.empty?

ledger_path = Pathname.new(ledger_argument).expand_path
root = ledger_path.dirname
errors = []

def present_string?(value)
  value.is_a?(String) && !value.strip.empty?
end

def add_error(errors, location, message)
  errors << "#{location}: #{message}"
end

begin
  ledger = YAML.safe_load(
    ledger_path.read,
    permitted_classes: [Date, Time],
    aliases: true
  )
rescue Errno::ENOENT
  abort "Conformance ledger not found: #{ledger_path}"
rescue Psych::Exception => error
  abort "Invalid YAML in #{ledger_path}: #{error.message}"
end

unless ledger.is_a?(Hash)
  abort "Conformance ledger root must be a mapping"
end

required_top_level = %w[
  version product updated source deployment_sets allowed_statuses status_contract
  evidence_contract allowed_kinds allowed_modules required_source_sections requirements
]
required_top_level.each do |key|
  add_error(errors, "ledger", "missing top-level #{key.inspect}") unless ledger.key?(key)
end

deployment_sets = ledger.fetch("deployment_sets", {})
deployments = deployment_sets.values.flatten.uniq
allowed_statuses = ledger.fetch("allowed_statuses", [])
allowed_kinds = ledger.fetch("allowed_kinds", [])
allowed_modules = ledger.fetch("allowed_modules", [])
evidence_contract = ledger.fetch("evidence_contract", {})
evidence_required_fields = evidence_contract.fetch("required_fields", [])
evidence_results = evidence_contract.fetch("allowed_results", [])
requirements = ledger.fetch("requirements", [])
evidence_root = root.join(ledger.fetch("evidence_root", ".")).cleanpath

add_error(errors, "deployment_sets", "must be a non-empty mapping") unless deployment_sets.is_a?(Hash) && !deployment_sets.empty?
add_error(errors, "requirements", "must be a non-empty list") unless requirements.is_a?(Array) && !requirements.empty?

requirement_by_id = {}
test_owner = {}

requirements.each_with_index do |requirement, index|
  location = "requirements[#{index}]"
  unless requirement.is_a?(Hash)
    add_error(errors, location, "must be a mapping")
    next
  end

  %w[id kind behavior owner source acceptance deployments status depends_on evidence].each do |key|
    add_error(errors, location, "missing #{key.inspect}") unless requirement.key?(key)
  end

  id = requirement["id"]
  unless present_string?(id) && id.match?(/\A[A-Z]{3,5}-\d{3}\z/)
    add_error(errors, location, "id must match AAA-000 through AAAAA-000")
    next
  end

  if requirement_by_id.key?(id)
    add_error(errors, id, "duplicate requirement ID")
  else
    requirement_by_id[id] = requirement
  end

  add_error(errors, id, "behavior must be a non-empty plain-language sentence") unless present_string?(requirement["behavior"])
  add_error(errors, id, "unknown kind #{requirement["kind"].inspect}") unless allowed_kinds.include?(requirement["kind"])
  add_error(errors, id, "unknown owner #{requirement["owner"].inspect}") unless allowed_modules.include?(requirement["owner"])
  add_error(errors, id, "unknown status #{requirement["status"].inspect}") unless allowed_statuses.include?(requirement["status"])

  source = requirement["source"]
  if source.is_a?(Hash) && present_string?(source["file"]) && present_string?(source["anchor"])
    source_path = root.join(source["file"])
    if !source_path.file?
      add_error(errors, id, "source file does not exist: #{source["file"]}")
    elsif source_path.extname.downcase == ".html"
      html = source_path.read
      anchor_pattern = /\bid\s*=\s*["']#{Regexp.escape(source["anchor"])}["']/
      add_error(errors, id, "source anchor ##{source["anchor"]} does not exist in #{source["file"]}") unless html.match?(anchor_pattern)
    end
  else
    add_error(errors, id, "source must contain non-empty file and anchor")
  end

  acceptance = requirement["acceptance"]
  if acceptance.is_a?(Hash)
    {"behavior" => "#{id}-B", "failure" => "#{id}-F"}.each do |test_kind, expected_id|
      test = acceptance[test_kind]
      if test.is_a?(Hash)
        test_id = test["id"]
        add_error(errors, id, "#{test_kind} test ID must be #{expected_id}") unless test_id == expected_id
        add_error(errors, id, "#{test_kind} test needs a non-empty description") unless present_string?(test["description"])
        if present_string?(test_id)
          if test_owner.key?(test_id)
            add_error(errors, id, "duplicate test ID #{test_id}")
          else
            test_owner[test_id] = id
          end
        end
      else
        add_error(errors, id, "acceptance.#{test_kind} must be a mapping")
      end
    end
  else
    add_error(errors, id, "acceptance must be a mapping")
  end

  applicable = requirement["deployments"]
  if !applicable.is_a?(Array) || applicable.empty?
    add_error(errors, id, "deployments must be a non-empty list")
  else
    unknown = applicable - deployments
    add_error(errors, id, "unknown deployments: #{unknown.join(", ")}") unless unknown.empty?
    add_error(errors, id, "deployments contains duplicates") unless applicable.uniq.length == applicable.length
  end

  dependencies = requirement["depends_on"]
  add_error(errors, id, "depends_on must be a list") unless dependencies.is_a?(Array)

  evidence = requirement["evidence"]
  if !evidence.is_a?(Array)
    add_error(errors, id, "evidence must be a list")
    evidence = []
  end

  evidence.each_with_index do |record, evidence_index|
    evidence_location = "#{id}.evidence[#{evidence_index}]"
    unless record.is_a?(Hash)
      add_error(errors, evidence_location, "must be a mapping")
      next
    end

    evidence_required_fields.each do |field|
      add_error(errors, evidence_location, "missing #{field.inspect}") unless record.key?(field)
    end

    unless applicable.is_a?(Array) && applicable.include?(record["deployment"])
      add_error(errors, evidence_location, "deployment is not applicable to #{id}")
    end
    add_error(errors, evidence_location, "unknown result #{record["result"].inspect}") unless evidence_results.include?(record["result"])
    add_error(errors, evidence_location, "run must identify a CI run, report, or local evidence path") unless present_string?(record["run"])
    add_error(errors, evidence_location, "recorded_at must be a date or timestamp") unless present_string?(record["recorded_at"]) || record["recorded_at"].is_a?(Date) || record["recorded_at"].is_a?(Time)

    tests = record["tests"]
    expected_tests = ["#{id}-B", "#{id}-F"]
    if !tests.is_a?(Array) || tests.empty?
      add_error(errors, evidence_location, "tests must be a non-empty list")
    else
      unknown_tests = tests - expected_tests
      add_error(errors, evidence_location, "contains tests owned by another requirement: #{unknown_tests.join(", ")}") unless unknown_tests.empty?
      add_error(errors, evidence_location, "tests contains duplicates") unless tests.uniq.length == tests.length
    end

    run = record["run"]
    if present_string?(run) && !run.start_with?("https://", "http://")
      evidence_path = evidence_root.join(run).cleanpath
      if !evidence_path.file?
        add_error(errors, evidence_location, "local evidence file does not exist: #{run}")
      elsif evidence_path.extname == ".json" && record["result"] == "pass" && tests.is_a?(Array)
        begin
          report = JSON.parse(evidence_path.read)
          passed_ids = Array(report["testResults"]).flat_map do |test_file|
            Array(test_file["assertionResults"]).select do |assertion|
              assertion["status"] == "passed"
            end.flat_map do |assertion|
              assertion.fetch("title", "").scan(/\b[A-Z]{3,5}-\d{3}-[BF]\b/u)
            end
          end.uniq
          unproved = tests - passed_ids
          add_error(errors, evidence_location, "evidence report does not contain passing results for #{unproved.join(", ")}") unless unproved.empty?
        rescue JSON::ParserError => error
          add_error(errors, evidence_location, "cannot parse JSON evidence: #{error.message}")
        end
      end
    end
  end

  status = requirement["status"]
  if status == "behavior_verified"
    behavior_id = "#{id}-B"
    has_behavior_proof = evidence.any? { |record| record.is_a?(Hash) && record["result"] == "pass" && Array(record["tests"]).include?(behavior_id) }
    add_error(errors, id, "behavior_verified requires passing behavior-test evidence") unless has_behavior_proof
  elsif status == "blocked"
    add_error(errors, id, "blocked requires a non-empty blocker") unless present_string?(requirement["blocker"])
  elsif status == "not_applicable"
    add_error(errors, id, "not_applicable requires a non-empty rationale") unless present_string?(requirement["rationale"])
  end
end

requirement_by_id.each do |id, requirement|
  Array(requirement["depends_on"]).each do |dependency|
    add_error(errors, id, "depends on itself") if dependency == id
    add_error(errors, id, "unknown dependency #{dependency.inspect}") unless requirement_by_id.key?(dependency)
  end
end

visiting = {}
visited = {}
visit = nil
visit = lambda do |id, path|
  return if visited[id]
  if visiting[id]
    cycle_start = path.index(id) || 0
    add_error(errors, id, "dependency cycle: #{(path[cycle_start..] + [id]).join(" -> ")}")
    return
  end

  visiting[id] = true
  Array(requirement_by_id[id]["depends_on"]).each do |dependency|
    visit.call(dependency, path + [id]) if requirement_by_id.key?(dependency)
  end
  visiting.delete(id)
  visited[id] = true
end
requirement_by_id.each_key { |id| visit.call(id, []) }

coverage = ledger.fetch("required_source_sections", {})
unless coverage.is_a?(Hash) && !coverage.empty?
  add_error(errors, "required_source_sections", "must be a non-empty mapping")
else
  coverage.each do |anchor, ids|
    location = "required_source_sections.#{anchor}"
    if !ids.is_a?(Array) || ids.empty?
      add_error(errors, location, "must name at least one requirement")
      next
    end
    ids.each do |id|
      if !requirement_by_id.key?(id)
        add_error(errors, location, "references unknown requirement #{id}")
      elsif requirement_by_id[id].dig("source", "anchor") != anchor
        add_error(errors, location, "#{id} cites ##{requirement_by_id[id].dig("source", "anchor")} instead of ##{anchor}")
      end
    end
  end
end

def proof_for(requirement, deployment)
  required_tests = ["#{requirement["id"]}-B", "#{requirement["id"]}-F"]
  passed_tests = Array(requirement["evidence"]).each_with_object([]) do |record, tests|
    next unless record.is_a?(Hash)
    next unless record["deployment"] == deployment && record["result"] == "pass"
    tests.concat(Array(record["tests"]))
  end.uniq
  [required_tests - passed_tests, passed_tests]
end

requirement_by_id.each do |id, requirement|
  next unless requirement["status"] == "verified"
  Array(requirement["deployments"]).each do |deployment|
    missing, = proof_for(requirement, deployment)
    add_error(errors, id, "verified but #{deployment} lacks passing evidence for #{missing.join(", ")}") unless missing.empty?
  end
end

unless errors.empty?
  warn "Conformance validation failed with #{errors.length} error#{errors.length == 1 ? "" : "s"}:"
  errors.each { |error| warn "- #{error}" }
  exit 1
end

puts "Valid conformance ledger: #{requirement_by_id.length} requirements, #{test_owner.length} tests, #{deployments.length} deployments."

if options[:report]
  puts
  puts "Requirement status"
  allowed_statuses.each do |status|
    count = requirements.count { |requirement| requirement["status"] == status }
    puts format("  %-20s %d", status, count)
  end

  puts
  puts "Deployment proof coverage"
  deployments.each do |deployment|
    applicable = requirements.select { |requirement| Array(requirement["deployments"]).include?(deployment) && requirement["status"] != "not_applicable" }
    proved = applicable.select { |requirement| proof_for(requirement, deployment).first.empty? }
    percentage = applicable.empty? ? 100.0 : (proved.length * 100.0 / applicable.length)
    puts format("  %-16s %3d/%-3d %6.2f%%", deployment, proved.length, applicable.length, percentage)
  end
end

options[:require_verified].each do |deployment|
  unless deployments.include?(deployment)
    warn "Unknown deployment for --require-verified: #{deployment}"
    exit 2
  end

  incomplete = requirements.select do |requirement|
    Array(requirement["deployments"]).include?(deployment) &&
      requirement["status"] != "not_applicable" &&
      !proof_for(requirement, deployment).first.empty?
  end

  next if incomplete.empty?

  warn "Deployment #{deployment} is not conformant: #{incomplete.length} requirements lack complete passing evidence."
  incomplete.first(25).each do |requirement|
    missing, = proof_for(requirement, deployment)
    warn "- #{requirement["id"]}: missing #{missing.join(", ")}"
  end
  warn "- ... #{incomplete.length - 25} more" if incomplete.length > 25
  exit 3
end
